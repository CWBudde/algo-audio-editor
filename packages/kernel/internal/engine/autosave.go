package engine

import (
	"encoding/binary"
	"fmt"
	"math"
	"slices"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

// Autosave gives the document's immutable blocks session-local IDs, so the
// worker's store writes each block once and recovery rebuilds the document
// from them. The kernel only exposes bytes; storage, scheduling and locking
// belong to the worker. All binary values are little-endian:
//
//	delta:  u32 freed, freed × u32 id,
//	        u32 channels (0 unless complete), per channel u32 n, n × u32 id,
//	        u32 blocks, blocks × record
//	record: u32 id, u32 frames, frames × float32
//
// recovery.blocks takes concatenated records; recovery.finish takes the layout
// (u32 channels, per channel u32 n, n × u32 id).
const (
	defaultAutosaveBytes = 32 << 20
	minAutosaveBytes     = 1 << 20
	maxAutosaveBytes     = 256 << 20
	autosaveRecordHeader = 8
)

type autosaveSubsystem struct {
	generation int64
	nextID     uint32
	// ids holds blocks the store has written. Blocks referenced by neither the
	// document nor history are freed and pruned on the next delta.
	ids         map[*audiobuf.Block]uint32
	staged      map[uint32]*audiobuf.Block
	stagedBytes int64
	stagedNext  uint32
}

// resetAutosave starts a generation for a newly installed document: the
// store must drop every block of the previous one.
func (e *Engine) resetAutosave() {
	e.autosave.generation++
	e.autosave.nextID = 0
	e.autosave.ids = nil
}

func (e *Engine) autosaveDelta(p protocol.AutosaveDeltaParams) (protocol.AutosaveDeltaResult, error) {
	const method = protocol.MethodAutosaveDelta
	limit := p.MaxBytes
	if limit == 0 {
		limit = defaultAutosaveBytes
	}
	if limit < minAutosaveBytes || limit > maxAutosaveBytes {
		return protocol.AutosaveDeltaResult{}, fmt.Errorf("%s: maxBytes %d must be 0 or in [%d, %d]", method, p.MaxBytes, minAutosaveBytes, maxAutosaveBytes)
	}
	a := &e.autosave
	if a.ids == nil {
		a.ids = make(map[*audiobuf.Block]uint32)
	}
	document := e.doc.document
	layout := make([][]*audiobuf.Block, document.Channels())
	current := make(map[*audiobuf.Block]struct{})
	var pending []*audiobuf.Block
	for i := range layout {
		channel, err := document.Channel(i)
		if err != nil {
			return protocol.AutosaveDeltaResult{}, fmt.Errorf("%s: channel: %w", method, err)
		}
		channel.Blocks(func(block *audiobuf.Block) bool {
			layout[i] = append(layout[i], block)
			if _, seen := current[block]; !seen {
				current[block] = struct{}{}
				if _, saved := a.ids[block]; !saved {
					pending = append(pending, block)
				}
			}
			return true
		})
	}
	var freed []uint32
	for block, id := range a.ids {
		if _, live := current[block]; live {
			continue
		}
		if h := e.historyState.history; h != nil && h.Retains(block) {
			continue
		}
		freed = append(freed, id)
		delete(a.ids, block)
	}
	slices.Sort(freed)

	emit, recordBytes := 0, 0
	for _, block := range pending {
		size := autosaveRecordHeader + 4*block.Frames()
		if emit > 0 && recordBytes+size > limit {
			break
		}
		emit++
		recordBytes += size
	}
	if uint64(a.nextID)+uint64(emit) > math.MaxUint32 {
		return protocol.AutosaveDeltaResult{}, fmt.Errorf("%s: block identity exhausted", method)
	}
	complete := emit == len(pending)
	total := 4 + 4*len(freed) + 4 + 4 + recordBytes
	if complete {
		for _, blocks := range layout {
			total += 4 + 4*len(blocks)
		}
	}
	if err := e.checkStorage(method, int64(total)); err != nil {
		return protocol.AutosaveDeltaResult{}, err
	}
	for _, block := range pending[:emit] {
		a.nextID++
		a.ids[block] = a.nextID
	}

	data := make([]byte, total)
	offset := 0
	put := func(value uint32) {
		binary.LittleEndian.PutUint32(data[offset:], value)
		offset += 4
	}
	put(uint32(len(freed))) // #nosec G115 -- Freed IDs are a subset of the uint32 IDs assigned so far.
	for _, id := range freed {
		put(id)
	}
	if complete {
		put(uint32(len(layout))) // #nosec G115 -- Documents have at most MaxChannels channels.
		for _, blocks := range layout {
			put(uint32(len(blocks))) // #nosec G115 -- The memory budget bounds a channel to far fewer than 2^32 blocks.
			for _, block := range blocks {
				put(a.ids[block])
			}
		}
	} else {
		put(0)
	}
	put(uint32(emit))
	scratch := make([]float32, audiobuf.BlockFrames)
	for _, block := range pending[:emit] {
		frames := block.Frames()
		put(a.ids[block])
		put(uint32(frames)) // #nosec G115 -- Blocks hold 1..BlockFrames (65536) frames.
		block.Read(scratch[:frames], 0)
		for _, sample := range scratch[:frames] {
			put(math.Float32bits(sample))
		}
	}
	e.bulkData = data
	return protocol.AutosaveDeltaResult{
		Generation: a.generation,
		Complete:   complete,
		Blocks:     emit,
		Freed:      len(freed),
		Pending:    len(pending) - emit,
		Document:   e.autosaveDocument(),
		DataBytes:  total,
	}, nil
}

func (e *Engine) autosaveDocument() protocol.AutosaveDocument {
	document := e.doc.document
	metadata := document.Metadata()
	result := protocol.AutosaveDocument{
		BinaryDocumentParams: binaryDocumentParams(document),
		Chunks:               make([]protocol.AutosaveChunk, len(metadata.WAVChunks)),
		SourceFormat:         e.doc.sourceFormat,
		SourceBitDepth:       e.doc.sourceBitDepth,
		SourceFloat:          e.doc.sourceFloat,
		Selection:            e.doc.editor.selection,
		Dirty:                e.historyState.history != nil && e.historyState.history.Dirty(),
	}
	for i, chunk := range metadata.WAVChunks {
		result.Chunks[i] = protocol.AutosaveChunk{ID: string(chunk.ID[:]), Data: chunk.Data}
	}
	return result
}

// beginRecovery discards any earlier staging. IDs continue at nextBlockId,
// so new blocks never reuse an ID the store has already written.
func (e *Engine) beginRecovery(p protocol.RecoveryBeginParams) (protocol.RecoveryResult, error) {
	if p.NextBlockID < 1 || p.NextBlockID > math.MaxUint32 {
		return protocol.RecoveryResult{}, fmt.Errorf("%s: nextBlockId %d must be in [1, %d]", protocol.MethodRecoveryBegin, p.NextBlockID, uint32(math.MaxUint32))
	}
	e.abortRecovery()
	e.autosave.staged = make(map[uint32]*audiobuf.Block)
	e.autosave.stagedNext = uint32(p.NextBlockID)
	return protocol.RecoveryResult{}, nil
}

func (e *Engine) abortRecovery() {
	e.autosave.staged, e.autosave.stagedBytes, e.autosave.stagedNext = nil, 0, 0
}

// stageRecoveryBlocks validates a whole batch before building any block, so a
// rejected batch leaves the staging unchanged.
func (e *Engine) stageRecoveryBlocks(input []byte) (protocol.RecoveryResult, error) {
	const method = protocol.MethodRecoveryBlocks
	a := &e.autosave
	if a.staged == nil {
		return protocol.RecoveryResult{}, fmt.Errorf("%s: recovery.begin required", method)
	}
	type record struct {
		id     uint32
		frames int
		offset int
	}
	var records []record
	batch := make(map[uint32]struct{})
	cost := int64(0)
	for offset := 0; offset < len(input); {
		if len(input)-offset < autosaveRecordHeader {
			return protocol.RecoveryResult{}, fmt.Errorf("%s: truncated record header", method)
		}
		id := binary.LittleEndian.Uint32(input[offset:])
		frames := int(binary.LittleEndian.Uint32(input[offset+4:]))
		if id == 0 || id >= a.stagedNext || frames < 1 || frames > audiobuf.BlockFrames || (len(input)-offset-autosaveRecordHeader)/4 < frames {
			return protocol.RecoveryResult{}, fmt.Errorf("%s: invalid record for block %d", method, id)
		}
		_, staged := a.staged[id]
		_, repeated := batch[id]
		if staged || repeated {
			return protocol.RecoveryResult{}, fmt.Errorf("%s: duplicate block %d", method, id)
		}
		batch[id] = struct{}{}
		records = append(records, record{id: id, frames: frames, offset: offset + autosaveRecordHeader})
		cost += decodedStorage(int64(frames), 1, frames)
		offset += autosaveRecordHeader + 4*frames
	}
	if err := e.checkStorage(method, cost+e.callInputBytes); err != nil {
		return protocol.RecoveryResult{}, err
	}
	scratch := make([]float32, audiobuf.BlockFrames)
	for _, r := range records {
		for i := range r.frames {
			scratch[i] = math.Float32frombits(binary.LittleEndian.Uint32(input[r.offset+4*i:]))
		}
		block, err := audiobuf.NewBlock(scratch[:r.frames])
		if err != nil {
			return protocol.RecoveryResult{}, fmt.Errorf("%s: storage: %w", method, err)
		}
		a.staged[r.id] = block
	}
	a.stagedBytes += cost
	return protocol.RecoveryResult{Blocks: len(a.staged), Bytes: a.stagedBytes}, nil
}

// finishRecovery installs the staged blocks in the layout's order as a new
// document with fresh history. The restored IDs continue the store's session,
// so the next delta writes only blocks created after recovery.
func (e *Engine) finishRecovery(p protocol.AutosaveDocument, input []byte) (protocol.DocumentInfoResult, error) {
	const method = protocol.MethodRecoveryFinish
	a := &e.autosave
	if a.staged == nil {
		return protocol.DocumentInfoResult{}, fmt.Errorf("%s: recovery.begin required", method)
	}
	if p.SampleRate < MinSampleRate || p.SampleRate > MaxSampleRate || p.Channels < 1 || p.Channels > MaxChannels || p.SourceBitDepth < 1 || p.SourceBitDepth > 32 {
		return protocol.DocumentInfoResult{}, fmt.Errorf("%s: invalid document format", method)
	}
	offset := 0
	next := func() (uint32, bool) {
		if len(input)-offset < 4 {
			return 0, false
		}
		value := binary.LittleEndian.Uint32(input[offset:])
		offset += 4
		return value, true
	}
	count, ok := next()
	if !ok || int(count) != p.Channels {
		return protocol.DocumentInfoResult{}, fmt.Errorf("%s: layout has the wrong channel count", method)
	}
	ids := make(map[*audiobuf.Block]uint32)
	channels := make([]audiobuf.Channel, p.Channels)
	for i := range channels {
		n, ok := next()
		if !ok || int64(n) > int64(len(input)-offset)/4 {
			return protocol.DocumentInfoResult{}, fmt.Errorf("%s: truncated layout", method)
		}
		blocks := make([]*audiobuf.Block, n)
		for j := range blocks {
			id, _ := next()
			block, staged := a.staged[id]
			if !staged {
				return protocol.DocumentInfoResult{}, fmt.Errorf("%s: layout references missing block %d", method, id)
			}
			blocks[j], ids[block] = block, id
		}
		var err error
		if channels[i], err = audiobuf.NewChannelFromBlocks(blocks); err != nil {
			return protocol.DocumentInfoResult{}, fmt.Errorf("%s: channel: %w", method, err)
		}
		if channels[i].Frames() != p.Frames {
			return protocol.DocumentInfoResult{}, fmt.Errorf("%s: channel %d has %d frames, want %d", method, i, channels[i].Frames(), p.Frames)
		}
	}
	if offset != len(input) {
		return protocol.DocumentInfoResult{}, fmt.Errorf("%s: trailing layout bytes", method)
	}
	timeline, err := timelineFromParams(p.BinaryDocumentParams)
	if err != nil {
		return protocol.DocumentInfoResult{}, fmt.Errorf("%s: timeline: %w", method, err)
	}
	chunks := make([]audiobuf.FileChunk, len(p.Chunks))
	for i, chunk := range p.Chunks {
		if len(chunk.ID) != 4 {
			return protocol.DocumentInfoResult{}, fmt.Errorf("%s: invalid chunk ID %q", method, chunk.ID)
		}
		chunks[i] = audiobuf.FileChunk{Data: chunk.Data}
		copy(chunks[i].ID[:], chunk.ID)
	}
	document, err := audiobuf.NewDocument(channels, p.SampleRate, audiobuf.Metadata{Name: p.Name, Tags: p.Tags, Timeline: timeline, WAVChunks: chunks})
	if err != nil {
		return protocol.DocumentInfoResult{}, fmt.Errorf("%s: document: %w", method, err)
	}
	nextID := a.stagedNext
	if _, err := e.installDocument(document, p.SourceBitDepth, p.SourceFloat, p.SourceFormat); err != nil {
		return protocol.DocumentInfoResult{}, fmt.Errorf("%s: %w", method, err)
	}
	if p.Dirty {
		e.historyState.history.MarkUnsaved()
	}
	s := p.Selection
	if e.validateEditorRange(method, s.Start, s.End) == nil && e.validateChannelMask(method, s.ChannelMask) == nil {
		e.doc.editor.selection = s
	}
	a.ids, a.nextID = ids, nextID-1
	e.abortRecovery()
	return e.documentInfo()
}

// binaryDocumentParams describes a document's metadata for binary handoffs.
func binaryDocumentParams(document audiobuf.Document) protocol.BinaryDocumentParams {
	metadata := document.Metadata()
	if metadata.Tags == nil {
		metadata.Tags = map[string]string{}
	}
	p := protocol.BinaryDocumentParams{Name: metadata.Name, Tags: metadata.Tags, SampleRate: document.SampleRate(), Channels: document.Channels(), Frames: document.Frames(), NextAnchorID: metadata.Timeline.NextID, Markers: make([]protocol.TimelineMarker, len(metadata.Timeline.Markers)), Regions: make([]protocol.TimelineRegion, len(metadata.Timeline.Regions))}
	for i, m := range metadata.Timeline.Markers {
		p.Markers[i] = protocol.TimelineMarker{ID: m.ID, Frame: m.Frame, Name: m.Name, Color: m.Color}
	}
	for i, r := range metadata.Timeline.Regions {
		p.Regions[i] = protocol.TimelineRegion{ID: r.ID, Start: r.Start, End: r.End, Name: r.Name, Color: r.Color}
	}
	return p
}

// timelineFromParams validates a binary handoff's anchors against its length.
func timelineFromParams(p protocol.BinaryDocumentParams) (audiobuf.Timeline, error) {
	timeline := audiobuf.Timeline{NextID: p.NextAnchorID, Markers: make([]audiobuf.Marker, len(p.Markers)), Regions: make([]audiobuf.Region, len(p.Regions))}
	for i, m := range p.Markers {
		timeline.Markers[i] = audiobuf.Marker{ID: m.ID, Frame: m.Frame, Name: m.Name, Color: m.Color}
	}
	for i, r := range p.Regions {
		timeline.Regions[i] = audiobuf.Region{ID: r.ID, Start: r.Start, End: r.End, Name: r.Name, Color: r.Color}
	}
	return timeline, timeline.Validate(p.Frames)
}
