package engine

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"path/filepath"
	"strings"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
	"github.com/cwbudde/wav"
	"github.com/go-audio/audio"
)

type wavLayout struct {
	fmtStart, fmtBytes   int
	dataStart, dataBytes int
	rate, channels       int
	bitDepth             int
	float                bool
	timelineChunks       []wavTimelineChunk
	timelineBytes        int
}

// inspectWAV validates every container boundary before the decoder sees any
// chunk lengths. It parses only structural fields; sample decoding stays in wav.
func inspectWAV(input []byte) (wavLayout, error) {
	var layout wavLayout
	if len(input) < 12 || string(input[:4]) != "RIFF" || string(input[8:12]) != "WAVE" {
		return layout, fmt.Errorf("wav.inspect: expected a RIFF/WAVE file")
	}
	end := uint64(binary.LittleEndian.Uint32(input[4:8])) + 8
	if end < 12 || end > uint64(len(input)) {
		return layout, fmt.Errorf("wav.inspect: truncated or invalid RIFF size %d", end)
	}
	seenFormat, seenData := false, false
	for pos := uint64(12); pos < end; {
		if end-pos < 8 {
			return layout, fmt.Errorf("wav.inspect: truncated chunk header at %d", pos)
		}
		size := uint64(binary.LittleEndian.Uint32(input[pos+4 : pos+8]))
		body, next := pos+8, pos+8+size+(size&1)
		if next > end {
			return layout, fmt.Errorf("wav.inspect: truncated %q chunk at %d", input[pos:pos+4], pos)
		}
		switch string(input[pos : pos+4]) {
		case "fmt ":
			if seenFormat {
				return layout, fmt.Errorf("wav.inspect: multiple format chunks")
			}
			if size < 16 {
				return layout, fmt.Errorf("wav.inspect: format chunk has %d bytes, want at least 16", size)
			}
			layout.fmtStart, layout.fmtBytes = int(body), int(size)
			if err := layout.inspectFormat(input[body : body+size]); err != nil {
				return wavLayout{}, err
			}
			seenFormat = true
		case "data":
			if seenData {
				return layout, fmt.Errorf("wav.inspect: multiple data chunks")
			}
			layout.dataStart, layout.dataBytes = int(body), int(size)
			seenData = true
		case "cue ", "aeMD", "LIST":
			id := [4]byte(input[pos : pos+4])
			if id == wav.CIDList && (size < 4 || string(input[body:body+4]) != "adtl") {
				break
			}
			if err := layout.addTimelineChunk(id, input[body:body+size]); err != nil {
				return wavLayout{}, err
			}
		}
		pos = next
	}
	if !seenFormat || !seenData {
		return layout, fmt.Errorf("wav.inspect: format and data chunks are required")
	}
	align := layout.channels * (layout.bitDepth / 8)
	if layout.dataBytes%align != 0 {
		return layout, fmt.Errorf("wav.inspect: data length %d is not a multiple of frame size %d", layout.dataBytes, align)
	}
	return layout, nil
}

func (l *wavLayout) inspectFormat(data []byte) error {
	tag := binary.LittleEndian.Uint16(data[:2])
	l.channels = int(binary.LittleEndian.Uint16(data[2:4]))
	l.rate = int(binary.LittleEndian.Uint32(data[4:8]))
	l.bitDepth = int(binary.LittleEndian.Uint16(data[14:16]))
	if l.rate < MinSampleRate || l.rate > MaxSampleRate || l.channels < 1 || l.channels > MaxChannels {
		return fmt.Errorf("wav.inspect: unsupported format %d Hz/%d channels", l.rate, l.channels)
	}
	if tag == 0xfffe {
		if len(data) < 40 || binary.LittleEndian.Uint16(data[16:18]) < 22 || int(binary.LittleEndian.Uint16(data[16:18])) > len(data)-18 {
			return fmt.Errorf("wav.inspect: incomplete extensible format")
		}
		guid := data[24:40]
		tail := []byte{0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71}
		if !bytes.Equal(guid[2:], tail) {
			return fmt.Errorf("wav.inspect: unsupported extensible subformat GUID")
		}
		tag = binary.LittleEndian.Uint16(guid[:2])
		validBits := int(binary.LittleEndian.Uint16(data[18:20]))
		if validBits > l.bitDepth || (tag == 3 && validBits != 0 && validBits != l.bitDepth) {
			return fmt.Errorf("wav.inspect: unsupported valid bit depth %d in %d-bit format", validBits, l.bitDepth)
		}
	}
	l.float = tag == 3
	if (tag != 1 && tag != 3) || (l.float && l.bitDepth != 32 && l.bitDepth != 64) || (!l.float && l.bitDepth != 8 && l.bitDepth != 16 && l.bitDepth != 24 && l.bitDepth != 32) {
		return fmt.Errorf("wav.inspect: unsupported WAV format %d/%d bits", tag, l.bitDepth)
	}
	align := l.channels * (l.bitDepth / 8)
	if int(binary.LittleEndian.Uint16(data[12:14])) != align || uint64(binary.LittleEndian.Uint32(data[8:12])) != uint64(l.rate)*uint64(align) {
		return fmt.Errorf("wav.inspect: inconsistent block alignment or byte rate")
	}
	return nil
}

func (e *Engine) openDocument(p protocol.DocumentOpenParams, input []byte) (protocol.DocumentInfoResult, error) {
	if e.documentSequence == math.MaxUint64 {
		return protocol.DocumentInfoResult{}, fmt.Errorf("doc.open: document identity sequence exhausted")
	}
	layout, err := inspectWAV(input)
	if err != nil {
		return protocol.DocumentInfoResult{}, fmt.Errorf("doc.open: validate WAV: %w", err)
	}
	frames := layout.dataBytes / (layout.channels * (layout.bitDepth / 8))
	timeline, err := decodeWAVTimeline(layout.timelineChunks, int64(frames))
	if err != nil {
		return protocol.DocumentInfoResult{}, fmt.Errorf("doc.open: import annotations: %w", err)
	}
	// Present only a small normalized fmt chunk and the validated data section
	// to the audio decoder; bounded timeline chunks were decoded separately.
	// General metadata mapping remains Phase 6.
	// The body references the caller's file bytes; no whole-file copy is made.
	reader := layout.reader(input)
	decoder := wav.NewDecoder(reader)
	if err := decoder.FwdToPCM(); err != nil {
		return protocol.DocumentInfoResult{}, fmt.Errorf("doc.open: locate PCM: %w", err)
	}
	decoder.PCMChunk.R = io.LimitReader(decoder.PCMChunk.R, int64(layout.dataBytes))
	blocks := make([][]*audiobuf.Block, layout.channels)
	for i := range blocks {
		blockCount := frames / audiobuf.BlockFrames
		if frames%audiobuf.BlockFrames != 0 {
			blockCount++
		}
		blocks[i] = make([]*audiobuf.Block, 0, blockCount)
	}
	pcm := &audio.Float32Buffer{Data: make([]float32, audiobuf.BlockFrames*layout.channels)}
	for remaining := frames; remaining > 0; {
		count := min(remaining, audiobuf.BlockFrames)
		pcm.Data = pcm.Data[:count*layout.channels]
		n, err := decoder.PCMBuffer(pcm)
		if err != nil {
			return protocol.DocumentInfoResult{}, fmt.Errorf("doc.open: decode PCM: %w", err)
		}
		if n != len(pcm.Data) {
			return protocol.DocumentInfoResult{}, fmt.Errorf("doc.open: decoded %d samples, want %d", n, len(pcm.Data))
		}
		for channel := range blocks {
			block, err := audiobuf.NewBlockFromInterleaved(pcm.Data, channel, layout.channels)
			if err != nil {
				return protocol.DocumentInfoResult{}, fmt.Errorf("doc.open: store channel %d: %w", channel, err)
			}
			blocks[channel] = append(blocks[channel], block)
		}
		remaining -= count
	}
	channels := make([]audiobuf.Channel, layout.channels)
	for i := range channels {
		channels[i], err = audiobuf.NewChannelFromBlocks(blocks[i])
		if err != nil {
			return protocol.DocumentInfoResult{}, fmt.Errorf("doc.open: channel %d: %w", i, err)
		}
	}
	name := p.Name
	if name == "" {
		name = "Untitled.wav"
	}
	document, err := audiobuf.NewDocument(channels, layout.rate, audiobuf.Metadata{Name: name, Timeline: timeline})
	if err != nil {
		return protocol.DocumentInfoResult{}, fmt.Errorf("doc.open: create document: %w", err)
	}
	editor := editorState{
		documentID: fmt.Sprintf("doc-%d", e.documentSequence+1),
		selection:  protocol.SelectionRange{ChannelMask: (1 << layout.channels) - 1},
	}
	stagedHistory, err := newDocumentHistory(document, editor)
	if err != nil {
		return protocol.DocumentInfoResult{}, fmt.Errorf("doc.open: initialize history: %w", err)
	}
	e.document, e.sourceBitDepth, e.sourceFloat = document, layout.bitDepth, layout.float
	e.transport = nil
	e.source = sourceStopped
	e.documentSequence++
	e.editor, e.history = editor, stagedHistory
	return e.documentInfo()
}

func (l wavLayout) reader(input []byte) *wavReadSeeker {
	fmtSize := 16
	if binary.LittleEndian.Uint16(input[l.fmtStart:l.fmtStart+2]) == 0xfffe {
		fmtSize = 40
	}
	header := make([]byte, 12+8+fmtSize+8)
	copy(header[:4], "RIFF")
	binary.LittleEndian.PutUint32(header[4:8], uint32(len(header)+l.dataBytes+(l.dataBytes&1)-8))
	copy(header[8:16], "WAVEfmt ")
	binary.LittleEndian.PutUint32(header[16:20], uint32(fmtSize))
	copy(header[20:20+fmtSize], input[l.fmtStart:l.fmtStart+fmtSize])
	if fmtSize == 40 {
		binary.LittleEndian.PutUint16(header[36:38], 22)
	}
	copy(header[20+fmtSize:], "data")
	binary.LittleEndian.PutUint32(header[24+fmtSize:], uint32(l.dataBytes))
	return &wavReadSeeker{header: header, data: input[l.dataStart : l.dataStart+l.dataBytes]}
}

func (e *Engine) documentInfo() (protocol.DocumentInfoResult, error) {
	if e.document.Channels() == 0 {
		return protocol.DocumentInfoResult{}, fmt.Errorf("doc.info: no document is open")
	}
	return protocol.DocumentInfoResult{
		DocumentID: e.editor.documentID,
		Name:       e.document.Metadata().Name, SampleRate: e.document.SampleRate(),
		Channels: e.document.Channels(), Frames: e.document.Frames(), BitDepth: e.sourceBitDepth, Float: e.sourceFloat,
	}, nil
}

func (e *Engine) exportDocument(p protocol.DocumentExportParams) (protocol.DocumentExportInfo, error) {
	document, indices, err := e.exportSource(p)
	if err != nil {
		return protocol.DocumentExportInfo{}, err
	}
	quantizers, err := exportQuantizers(document, indices, p)
	if err != nil {
		return protocol.DocumentExportInfo{}, err
	}
	dataBytes := document.Frames() * int64(document.Channels()) * int64(p.BitDepth/8)
	chunks, metadataBytes, err := encodeWAVTimeline(document.Metadata().Timeline, document.Frames())
	if err != nil {
		return protocol.DocumentExportInfo{}, fmt.Errorf("doc.export: annotations: %w", err)
	}
	fileBytes := dataBytes + (dataBytes & 1) + 44 + metadataBytes
	if fileBytes-8 > math.MaxUint32 || fileBytes > int64(math.MaxInt) {
		return protocol.DocumentExportInfo{}, fmt.Errorf("doc.export: document exceeds RIFF/WASM size limit")
	}
	writer := &memoryWriteSeeker{data: make([]byte, 0, int(fileBytes)), limit: int(fileBytes)}
	formatTag := 1
	if p.Float {
		formatTag = 3
	}
	encoder := wav.NewEncoder(writer, document.SampleRate(), p.BitDepth, document.Channels(), formatTag)
	encoder.SetRawChunks(chunks)
	format := &audio.Format{NumChannels: document.Channels(), SampleRate: document.SampleRate()}
	var pcm *audio.Float32Buffer
	var integers *audio.IntBuffer
	if quantizers == nil {
		pcm = &audio.Float32Buffer{Data: make([]float32, audiobuf.BlockFrames*document.Channels()), Format: format}
	} else {
		integers = &audio.IntBuffer{Data: make([]int, audiobuf.BlockFrames*document.Channels()), Format: format, SourceBitDepth: p.BitDepth}
	}
	writeFrames := func(frames int) error {
		if integers != nil {
			integers.Data = integers.Data[:frames*document.Channels()]
			return encoder.WriteInt(integers)
		}
		pcm.Data = pcm.Data[:frames*document.Channels()]
		return encoder.Write(pcm)
	}
	mono := make([]float32, audiobuf.BlockFrames)
	channels := make([]audiobuf.Channel, document.Channels())
	for i := range channels {
		var err error
		channels[i], err = document.Channel(i)
		if err != nil {
			return protocol.DocumentExportInfo{}, fmt.Errorf("doc.export: channel %d: %w", i, err)
		}
	}
	// An empty Write emits a valid fmt/data header even for a zero-frame file.
	if document.Frames() == 0 {
		if err := writeFrames(0); err != nil {
			return protocol.DocumentExportInfo{}, fmt.Errorf("doc.export: encode empty PCM: %w", err)
		}
	}
	for start := int64(0); start < document.Frames(); start += audiobuf.BlockFrames {
		frames := int(min(int64(audiobuf.BlockFrames), document.Frames()-start))
		for i, channel := range channels {
			if n := channel.Read(mono[:frames], start); n != frames {
				return protocol.DocumentExportInfo{}, fmt.Errorf("doc.export: channel %d read %d of %d frames", i, n, frames)
			}
			for frame := range frames {
				if integers != nil {
					integers.Data[frame*len(channels)+i] = quantizers[i].ProcessInteger(float64(mono[frame]))
				} else {
					pcm.Data[frame*len(channels)+i] = mono[frame]
				}
			}
		}
		if err := writeFrames(frames); err != nil {
			return protocol.DocumentExportInfo{}, fmt.Errorf("doc.export: encode PCM: %w", err)
		}
	}
	if err := encoder.Close(); err != nil {
		return protocol.DocumentExportInfo{}, fmt.Errorf("doc.export: finish WAV: %w", err)
	}
	e.bulkData = writer.data
	name := document.Metadata().Name
	if p.Scope == "selection" {
		name = strings.TrimSuffix(name, filepath.Ext(name))
		if name == "" {
			name = "Untitled"
		}
		name += "-selection.wav"
	}
	if !strings.HasSuffix(strings.ToLower(name), ".wav") {
		name += ".wav"
	}
	return protocol.DocumentExportInfo{Name: name, MimeType: "audio/wav", DataBytes: len(writer.data)}, nil
}
