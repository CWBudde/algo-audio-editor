package engine

import (
	"encoding/binary"
	"fmt"
	"math"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

// exportCandidate transfers exact sample representations and metadata. It never
// commits the candidate or changes the source document/history/save point.
func (e *Engine) exportCandidate(p protocol.ProcessJobParams) (protocol.BinaryDocumentInfo, error) {
	const method = protocol.MethodProcessExportCandidate
	job, err := e.activeProcess(method, p)
	if err != nil {
		return protocol.BinaryDocumentInfo{}, err
	}
	if job.result.State != protocol.JobReady {
		return protocol.BinaryDocumentInfo{}, fmt.Errorf("%s: ready candidate required", method)
	}
	document := job.candidate
	frames, channels := document.Frames(), document.Channels()
	if frames > e.exportStorageLimit()/4/int64(channels) {
		return protocol.BinaryDocumentInfo{}, fmt.Errorf("%s: transfer exceeds output budget", method)
	}
	metadata := document.Metadata()
	info := protocol.BinaryDocumentInfo{BinaryDocumentParams: protocol.BinaryDocumentParams{Name: metadata.Name, Tags: metadata.Tags, SampleRate: document.SampleRate(), Channels: channels, Frames: frames, NextAnchorID: metadata.Timeline.NextID, Markers: make([]protocol.TimelineMarker, len(metadata.Timeline.Markers)), Regions: make([]protocol.TimelineRegion, len(metadata.Timeline.Regions))}, DataBytes: int(frames) * channels * 4}
	for i, m := range metadata.Timeline.Markers {
		info.Markers[i] = protocol.TimelineMarker{ID: m.ID, Frame: m.Frame, Name: m.Name, Color: m.Color}
	}
	for i, r := range metadata.Timeline.Regions {
		info.Regions[i] = protocol.TimelineRegion{ID: r.ID, Start: r.Start, End: r.End, Name: r.Name, Color: r.Color}
	}
	data := make([]byte, info.DataBytes)
	scratch := make([]float32, audiobuf.BlockFrames)
	for channel := range channels {
		source, _ := document.Channel(channel)
		for start := int64(0); start < frames; start += audiobuf.BlockFrames {
			count := int(min(int64(audiobuf.BlockFrames), frames-start))
			if source.Read(scratch[:count], start) != count {
				return protocol.BinaryDocumentInfo{}, fmt.Errorf("%s: incomplete source read", method)
			}
			base := (int64(channel)*frames + start) * 4
			for i, value := range scratch[:count] {
				binary.LittleEndian.PutUint32(data[base+int64(i)*4:], math.Float32bits(value))
			}
		}
	}
	e.bulkData = data
	return info, nil
}

func (e *Engine) importBinaryDocument(p protocol.BinaryDocumentParams, data []byte) (protocol.DocumentInfoResult, error) {
	return e.importBinaryDocumentMode(p, data, false)
}

func (e *Engine) importBinaryDocumentMode(p protocol.BinaryDocumentParams, data []byte, replace bool) (protocol.DocumentInfoResult, error) {
	method := protocol.MethodDocumentImportBinary
	if replace {
		method = protocol.MethodDocumentOpenPCM
	}
	if !replace && e.doc.document.Channels() != 0 {
		return protocol.DocumentInfoResult{}, fmt.Errorf("%s: destination must be an empty editor", method)
	}
	if p.SampleRate < MinSampleRate || p.SampleRate > MaxSampleRate || p.Channels < 1 || p.Channels > MaxChannels || p.Frames < 0 || p.Frames > maxProcessOutputBytes/4/int64(p.Channels) || int64(len(data)) != p.Frames*4*int64(p.Channels) {
		return protocol.DocumentInfoResult{}, fmt.Errorf("%s: invalid format or binary length", method)
	}
	if e.doc.documentSequence == math.MaxUint64 {
		return protocol.DocumentInfoResult{}, fmt.Errorf("%s: document identity exhausted", method)
	}
	if err := e.checkDecodedStorage(p.Frames, p.Channels, audiobuf.BlockFrames, len(data)); err != nil {
		return protocol.DocumentInfoResult{}, err
	}
	timeline := audiobuf.Timeline{NextID: p.NextAnchorID, Markers: make([]audiobuf.Marker, len(p.Markers)), Regions: make([]audiobuf.Region, len(p.Regions))}
	for i, m := range p.Markers {
		timeline.Markers[i] = audiobuf.Marker{ID: m.ID, Frame: m.Frame, Name: m.Name, Color: m.Color}
	}
	for i, r := range p.Regions {
		timeline.Regions[i] = audiobuf.Region{ID: r.ID, Start: r.Start, End: r.End, Name: r.Name, Color: r.Color}
	}
	if err := timeline.Validate(p.Frames); err != nil {
		return protocol.DocumentInfoResult{}, fmt.Errorf("%s: timeline: %w", method, err)
	}
	channels := make([]audiobuf.Channel, p.Channels)
	scratch := make([]float32, audiobuf.BlockFrames)
	for channel := range p.Channels {
		blocks := make([]*audiobuf.Block, 0, int((p.Frames+audiobuf.BlockFrames-1)/audiobuf.BlockFrames))
		for start := int64(0); start < p.Frames; start += audiobuf.BlockFrames {
			count := int(min(int64(audiobuf.BlockFrames), p.Frames-start))
			base := (int64(channel)*p.Frames + start) * 4
			for i := range count {
				scratch[i] = math.Float32frombits(binary.LittleEndian.Uint32(data[base+int64(i)*4:]))
			}
			block, err := audiobuf.NewBlock(scratch[:count])
			if err != nil {
				return protocol.DocumentInfoResult{}, fmt.Errorf("%s: storage: %w", method, err)
			}
			blocks = append(blocks, block)
		}
		var err error
		channels[channel], err = audiobuf.NewChannelFromBlocks(blocks)
		if err != nil {
			return protocol.DocumentInfoResult{}, fmt.Errorf("%s: channel: %w", method, err)
		}
	}
	document, err := audiobuf.NewDocument(channels, p.SampleRate, audiobuf.Metadata{Name: p.Name, Tags: p.Tags, Timeline: timeline})
	if err != nil {
		return protocol.DocumentInfoResult{}, fmt.Errorf("%s: document: %w", method, err)
	}
	editor := editorState{documentID: fmt.Sprintf("doc-%d", e.doc.documentSequence+1), selection: protocol.SelectionRange{ChannelMask: (1 << p.Channels) - 1}}
	staged, err := e.newDocumentHistory(document, editor)
	if err != nil {
		return protocol.DocumentInfoResult{}, fmt.Errorf("%s: history: %w", method, err)
	}
	if !replace {
		staged.MarkUnsaved()
	}
	e.doc.document, e.doc.editor, e.historyState.history = document, editor, staged
	e.doc.documentSequence++
	e.doc.sourceBitDepth, e.doc.sourceFloat = 32, true
	e.doc.sourceFormat = "wav"
	e.playback.transport, e.playback.source = nil, sourceStopped
	e.effectsState.impulseResponses = nil
	e.effectsState.impulseBytes = 0
	e.resetMeters()
	e.analysis.analysisJob = nil
	e.analysis.analysisCache = nil
	e.analysis.cancelledAnalysis = nil
	return e.documentInfo()
}
