package engine

import (
	"bytes"
	"crypto/md5" // #nosec G501 -- FLAC mandates MD5 of decoded PCM; this is format integrity, not authentication.
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"path/filepath"
	"strings"

	"github.com/cwbudde/aiff"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
	"github.com/cwbudde/flac"
	"github.com/cwbudde/flac/frame"
	"github.com/cwbudde/flac/meta"
	"github.com/hajimehoshi/go-mp3"
)

// The format comes from the container, never from the filename. Known malformed
// formats must fail their decoder; they must not fall through to browser codecs.
func (e *Engine) openDocument(p protocol.DocumentOpenParams, input []byte) (protocol.DocumentInfoResult, error) {
	if len(input) >= 12 && (string(input[:4]) == "RIFF" || string(input[:4]) == "RF64") && string(input[8:12]) == "WAVE" {
		return e.openWAVDocument(p, input)
	}
	input, err := skipID3(input)
	if err != nil {
		return protocol.DocumentInfoResult{}, err
	}
	switch {
	case len(input) >= 4 && string(input[:4]) == "fLaC":
		return e.openFLAC(p, input)
	case len(input) >= 12 && string(input[:4]) == "FORM" && (string(input[8:12]) == "AIFF" || string(input[8:12]) == "AIFC"):
		return e.openAIFF(p, input)
	case len(input) >= 2 && input[0] == 255 && input[1]&0xe0 == 0xe0:
		return e.openMP3(p, input)
	default:
		return protocol.DocumentInfoResult{}, fmt.Errorf("doc.open: unsupported audio container")
	}
}

func skipID3(input []byte) ([]byte, error) {
	if len(input) < 3 || string(input[:3]) != "ID3" {
		return input, nil
	}
	if len(input) < 10 || input[3] < 2 || input[3] > 4 || input[6]&128 != 0 || input[7]&128 != 0 || input[8]&128 != 0 || input[9]&128 != 0 {
		return nil, fmt.Errorf("doc.open: invalid ID3 header")
	}
	n := 10 + (int(input[6])<<21 | int(input[7])<<14 | int(input[8])<<7 | int(input[9]))
	if input[3] == 4 && input[5]&16 != 0 {
		n += 10
	}
	if n > len(input) {
		return nil, fmt.Errorf("doc.open: truncated ID3 tag")
	}
	return input[n:], nil
}

func validateDecodedFormat(rate, channels, depth int, frames int64) error {
	if rate < MinSampleRate || rate > MaxSampleRate || channels < 1 || channels > MaxChannels || depth < 1 || depth > 32 || frames < 0 || frames > maxProcessOutputBytes/4/int64(channels) {
		return fmt.Errorf("doc.open: unsupported format or decoded audio exceeds memory budget")
	}
	return nil
}

// installDocument stages history before replacing any live state.
func (e *Engine) installDocument(document audiobuf.Document, depth int, isFloat bool, format string) (protocol.DocumentInfoResult, error) {
	if e.doc.documentSequence == math.MaxUint64 {
		return protocol.DocumentInfoResult{}, fmt.Errorf("doc.open: document identity exhausted")
	}
	editor := editorState{documentID: fmt.Sprintf("doc-%d", e.doc.documentSequence+1), selection: protocol.SelectionRange{ChannelMask: (1 << document.Channels()) - 1}}
	history, err := e.newDocumentHistory(document, editor)
	if err != nil {
		return protocol.DocumentInfoResult{}, fmt.Errorf("doc.open: initialize history: %w", err)
	}
	e.doc.document, e.doc.sourceBitDepth, e.doc.sourceFloat = document, depth, isFloat
	e.doc.documentSequence++
	e.doc.sourceFormat = format
	e.doc.editor, e.historyState.history = editor, history
	e.playback.transport, e.playback.source = nil, sourceStopped
	e.effectsState.impulseResponses = nil
	e.effectsState.impulseBytes = 0
	e.resetMeters()
	e.analysis.analysisJob = nil
	e.analysis.analysisCache = nil
	e.analysis.cancelledAnalysis = nil
	return e.documentInfo()
}

func (e *Engine) installPCM(p protocol.DocumentOpenParams, blocks [][]*audiobuf.Block, rate, depth int, format string) (protocol.DocumentInfoResult, error) {
	channels := make([]audiobuf.Channel, len(blocks))
	for i := range channels {
		var err error
		channels[i], err = audiobuf.NewChannelFromBlocks(blocks[i])
		if err != nil {
			return protocol.DocumentInfoResult{}, fmt.Errorf("doc.open: storage: %w", err)
		}
	}
	name := p.Name
	if name == "" {
		name = "Untitled"
	}
	document, err := audiobuf.NewDocument(channels, rate, audiobuf.Metadata{Name: name})
	if err != nil {
		return protocol.DocumentInfoResult{}, fmt.Errorf("doc.open: document: %w", err)
	}
	return e.installDocument(document, depth, false, format)
}

func appendPCM(blocks [][]*audiobuf.Block, pcm [][]int32, depth int) error {
	scratch := make([]float32, len(pcm[0]))
	scale := math.Ldexp(1, 1-depth)
	for ch := range blocks {
		if len(pcm[ch]) != len(scratch) {
			return fmt.Errorf("doc.open: inconsistent channel length")
		}
		for i, v := range pcm[ch] {
			scratch[i] = float32(float64(v) * scale)
		}
		block, err := audiobuf.NewBlock(scratch)
		if err != nil {
			return err
		}
		blocks[ch] = append(blocks[ch], block)
	}
	return nil
}

func (e *Engine) openAIFF(p protocol.DocumentOpenParams, input []byte) (protocol.DocumentInfoResult, error) {
	d, err := aiff.NewPCMReader(bytes.NewReader(input))
	if err != nil {
		return protocol.DocumentInfoResult{}, fmt.Errorf("doc.open: AIFF: %w", err)
	}
	f := d.Format
	if err = validateDecodedFormat(f.SampleRate, f.Channels, f.BitDepth, f.Frames); err != nil {
		return protocol.DocumentInfoResult{}, err
	}
	if err = e.checkDecodedStorage(f.Frames, f.Channels, audiobuf.BlockFrames, len(input)); err != nil {
		return protocol.DocumentInfoResult{}, err
	}
	blocks := make([][]*audiobuf.Block, f.Channels)
	interleaved := make([]int32, audiobuf.BlockFrames*f.Channels)
	pcm := make([][]int32, f.Channels)
	for ch := range pcm {
		pcm[ch] = make([]int32, audiobuf.BlockFrames)
	}
	for remaining := f.Frames; remaining > 0; {
		count := int(min(int64(audiobuf.BlockFrames), remaining))
		n, err := d.ReadPCM(interleaved[:count*f.Channels])
		if err != nil {
			return protocol.DocumentInfoResult{}, fmt.Errorf("doc.open: AIFF PCM: %w", err)
		}
		if n != count*f.Channels {
			return protocol.DocumentInfoResult{}, fmt.Errorf("doc.open: incomplete AIFF PCM (%d/%d): %w", n, count*f.Channels, io.ErrUnexpectedEOF)
		}
		for ch := range pcm {
			pcm[ch] = pcm[ch][:count]
			for i := range count {
				pcm[ch][i] = interleaved[i*f.Channels+ch]
			}
		}
		if err = appendPCM(blocks, pcm, f.BitDepth); err != nil {
			return protocol.DocumentInfoResult{}, err
		}
		remaining -= int64(count)
	}
	return e.installPCM(p, blocks, f.SampleRate, f.BitDepth, "aiff")
}

func (e *Engine) openFLAC(p protocol.DocumentOpenParams, input []byte) (protocol.DocumentInfoResult, error) {
	// New parses STREAMINFO and skips other metadata without decoding pictures/tags.
	d, err := flac.New(bytes.NewReader(input))
	if err != nil {
		return protocol.DocumentInfoResult{}, fmt.Errorf("doc.open: FLAC header: %w", err)
	}
	info := d.Info
	rate, channels, depth := int(info.SampleRate), int(info.NChannels), int(info.BitsPerSample)
	if info.NSamples > math.MaxInt64 {
		return protocol.DocumentInfoResult{}, fmt.Errorf("doc.open: FLAC sample count exceeds signed frame range")
	}
	frames := int64(info.NSamples)
	if err = validateDecodedFormat(rate, channels, depth, frames); err != nil {
		return protocol.DocumentInfoResult{}, err
	}
	// STREAMINFO bounds sample volume; actual frame sizes are charged below.
	// A single small frame must not force every frame's estimate to that size.
	if err = e.checkDecodedStorage(frames, channels, audiobuf.BlockFrames, len(input)); err != nil {
		return protocol.DocumentInfoResult{}, err
	}
	blocks := make([][]*audiobuf.Block, channels)
	var total int64
	var stored int64
	// Import is synchronous and stages all new blocks privately. Retained
	// editor state cannot change, so scan its history/clipboard just once.
	available := e.availableStorage() - max(int64(len(input)), e.callInputBytes)
	hash := md5.New() // #nosec G401 -- Compare the checksum required by FLAC STREAMINFO, not a security credential.
	for {
		f, err := d.ParseNext()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return protocol.DocumentInfoResult{}, fmt.Errorf("doc.open: FLAC frame: %w", err)
		}
		f.Hash(hash)
		count := int(f.BlockSize)
		if count == 0 || len(f.Subframes) != channels || int(f.BitsPerSample) != depth || (f.SampleRate != 0 && int(f.SampleRate) != rate) {
			return protocol.DocumentInfoResult{}, fmt.Errorf("doc.open: inconsistent FLAC frame format")
		}
		if err = validateDecodedFormat(rate, channels, depth, total+int64(count)); err != nil {
			return protocol.DocumentInfoResult{}, err
		}
		if frames != 0 && total+int64(count) > frames {
			return protocol.DocumentInfoResult{}, fmt.Errorf("doc.open: FLAC exceeds declared frame count")
		}
		stored += decodedStorage(int64(count), channels, count)
		if stored > available {
			return protocol.DocumentInfoResult{}, fmt.Errorf("doc.open: decoded FLAC exceeds memory budget")
		}
		pcm := make([][]int32, channels)
		for ch := range pcm {
			pcm[ch] = f.Subframes[ch].Samples
		}
		if err = appendPCM(blocks, pcm, depth); err != nil {
			return protocol.DocumentInfoResult{}, fmt.Errorf("doc.open: FLAC storage: %w", err)
		}
		total += int64(count)
	}
	if info.NSamples != 0 && uint64(total) != info.NSamples {
		return protocol.DocumentInfoResult{}, fmt.Errorf("doc.open: truncated FLAC audio")
	}
	if info.MD5sum != ([16]byte{}) && !bytes.Equal(hash.Sum(nil), info.MD5sum[:]) {
		return protocol.DocumentInfoResult{}, fmt.Errorf("doc.open: FLAC decoded checksum mismatch")
	}
	return e.installPCM(p, blocks, rate, depth, "flac")
}

func (e *Engine) openMP3(p protocol.DocumentOpenParams, input []byte) (protocol.DocumentInfoResult, error) {
	blocks, rate, err := e.decodeMP3(input)
	if err != nil {
		return protocol.DocumentInfoResult{}, err
	}
	return e.installPCM(p, blocks, rate, 16, "mp3")
}

// decodeMP3 decodes the whole stream into blocks. go-mp3 indexes its tables
// with values read from the stream and panics on some malformed frames (found
// by FuzzWAVOpen); report those as bad input instead of crashing the kernel.
// The recover covers only the third-party decode, never document installation.
func (e *Engine) decodeMP3(input []byte) (blocks [][]*audiobuf.Block, rate int, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			blocks, rate, err = nil, 0, fmt.Errorf("doc.open: malformed MP3: %v", recovered)
		}
	}()
	info, err := inspectMP3(input)
	if err != nil {
		return nil, 0, err
	}
	// Hide Seek to avoid go-mp3's eager frame index scan; decoding stays bounded.
	d, err := mp3.NewDecoder(bytes.NewBuffer(input[info.tagBytes:]))
	if err != nil {
		return nil, 0, fmt.Errorf("doc.open: MP3: %w", err)
	}
	rate = d.SampleRate()
	if err = validateDecodedFormat(rate, info.channels, 16, 0); err != nil {
		return nil, 0, err
	}
	blocks = make([][]*audiobuf.Block, info.channels)
	raw := make([]byte, audiobuf.BlockFrames*4)
	pcm := make([][]int32, info.channels)
	for ch := range pcm {
		pcm[ch] = make([]int32, audiobuf.BlockFrames)
	}
	skip := int64(0)
	tail := int64(0)
	if info.gapless {
		skip += info.delay + 529
		tail = info.padding - 529
	}
	var decoded int64
	var total int64
	var stored int64
	available := e.availableStorage() - max(int64(len(input)), e.callInputBytes)
	for {
		n, err := io.ReadFull(d, raw)
		if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
			return nil, 0, fmt.Errorf("doc.open: MP3 PCM: %w", err)
		}
		if n == 0 {
			break
		}
		if n%4 != 0 {
			return nil, 0, fmt.Errorf("doc.open: partial MP3 frame")
		}
		decoded += int64(n / 4)
		// Retain all decode state, but drop metadata and encoder/decoder lead-in.
		first := int(min(skip, int64(n/4)))
		skip -= int64(first)
		count := n/4 - first
		if count > 0 {
			if validation := validateDecodedFormat(rate, info.channels, 16, total+int64(count)); validation != nil {
				return nil, 0, validation
			}
			stored += decodedStorage(int64(count), info.channels, count)
			if stored > available {
				return nil, 0, fmt.Errorf("doc.open: decoded MP3 exceeds memory budget")
			}
			for ch := range pcm {
				pcm[ch] = pcm[ch][:count]
				for i := range count {
					pcm[ch][i] = int32(int16(binary.LittleEndian.Uint16(raw[(i+first)*4+ch*2:]))) // #nosec G115 -- Reinterpret the signed two's-complement PCM16 bits emitted by the MP3 decoder.
				}
			}
			if err = appendPCM(blocks, pcm, 16); err != nil {
				return nil, 0, err
			}
			total += int64(count)
		}
		if n < len(raw) {
			break
		}
	}
	if info.hasCount && decoded != info.audioFrames {
		return nil, 0, fmt.Errorf("doc.open: MP3 audio does not match Xing frame count")
	}
	if skip > 0 || tail >= total && info.gapless {
		return nil, 0, fmt.Errorf("doc.open: MP3 shorter than gapless interval")
	}
	if tail > 0 {
		for ch := range blocks {
			remaining := total - tail
			for i, block := range blocks[ch] {
				if remaining > int64(block.Frames()) {
					remaining -= int64(block.Frames())
					continue
				}
				if remaining < int64(block.Frames()) {
					samples := make([]float32, int(remaining))
					if block.Read(samples, 0) != len(samples) {
						return nil, 0, fmt.Errorf("doc.open: short MP3 tail read")
					}
					trimmed, err := audiobuf.NewBlock(samples)
					if err != nil {
						return nil, 0, fmt.Errorf("doc.open: MP3 trim: %w", err)
					}
					blocks[ch][i] = trimmed
				}
				clear(blocks[ch][i+1:])
				blocks[ch] = blocks[ch][:i+1]
				break
			}
		}
	}

	return blocks, rate, nil
}

func (e *Engine) exportDocument(p protocol.DocumentExportParams) (protocol.DocumentExportInfo, error) {
	if p.Format == "wav" {
		return e.exportWAVDocument(p)
	}
	document, indices, err := e.exportSource(p)
	if err != nil {
		return protocol.DocumentExportInfo{}, err
	}
	// Avoid silent loss of editable tags or opaque source metadata.
	if len(document.Metadata().Tags) > 0 || len(document.Metadata().WAVChunks) > 0 {
		return protocol.DocumentExportInfo{}, fmt.Errorf("doc.export: FLAC/AIFF metadata mapping is not available; export WAV to preserve file metadata")
	}
	// Timeline containers remain WAV until format-specific metadata mapping lands.
	if len(document.Metadata().Timeline.Markers) > 0 || len(document.Metadata().Timeline.Regions) > 0 {
		return protocol.DocumentExportInfo{}, fmt.Errorf("doc.export: FLAC/AIFF annotation mapping is not available; export WAV to preserve markers and regions")
	}
	quantizers, err := exportQuantizers(document, indices, p)
	if err != nil {
		return protocol.DocumentExportInfo{}, err
	}
	writer := &memoryWriteSeeker{limit: int(e.exportStorageLimit()), budget: e}
	var write func([][]int32) error
	var closeEncoder func() error
	switch p.Format {
	case "aiff":
		enc, err := aiff.NewPCMWriter(writer, aiff.PCMFormat{SampleRate: document.SampleRate(), Channels: document.Channels(), BitDepth: p.BitDepth, Frames: document.Frames()})
		if err != nil {
			return protocol.DocumentExportInfo{}, fmt.Errorf("doc.export: initialize AIFF encoder: %w", err)
		}
		interleaved := make([]int32, 4096*document.Channels())
		write = func(pcm [][]int32) error {
			n := len(pcm[0])
			for ch := range pcm {
				for i, v := range pcm[ch] {
					interleaved[i*len(pcm)+ch] = v
				}
			}
			return enc.WritePCM(interleaved[:n*len(pcm)])
		}
		closeEncoder = enc.Close
	case "flac":
		if document.Frames() == 0 {
			return protocol.DocumentExportInfo{}, fmt.Errorf("doc.export: FLAC requires at least one frame")
		}
		enc, err := flac.NewEncoder(writer, &meta.StreamInfo{SampleRate: uint32(document.SampleRate()), NChannels: uint8(document.Channels()), BitsPerSample: uint8(p.BitDepth), BlockSizeMin: 4096, BlockSizeMax: 4096}) // #nosec G115 -- exportSource supplies a validated document rate (8000..384000 Hz), channel count (1..8) and bit depth.
		if err != nil {
			return protocol.DocumentExportInfo{}, fmt.Errorf("doc.export: initialize FLAC encoder: %w", err)
		}
		write = func(pcm [][]int32) error {
			n := len(pcm[0])
			if n < 1 || n > 4096 {
				return fmt.Errorf("doc.export: invalid FLAC block size %d", n)
			}
			f := &frame.Frame{Header: frame.Header{BlockSize: uint16(n), SampleRate: uint32(document.SampleRate()), BitsPerSample: uint8(p.BitDepth), Channels: frame.Channels(document.Channels() - 1)}} // #nosec G115 -- Block size is checked above and document rate is validated by exportSource.
			for _, samples := range pcm {
				f.Subframes = append(f.Subframes, &frame.Subframe{SubHeader: frame.SubHeader{Pred: frame.PredVerbatim}, Samples: samples, NSamples: n})
			}
			return enc.WriteFrame(f)
		}
		closeEncoder = enc.Close
	default:
		return protocol.DocumentExportInfo{}, fmt.Errorf("doc.export: unsupported format")
	}
	pcm := make([][]int32, document.Channels())
	sources := make([]audiobuf.Channel, document.Channels())
	for ch := range pcm {
		pcm[ch] = make([]int32, 4096)
		sources[ch], _ = document.Channel(ch)
	}
	scratch := make([]float32, 4096)
	scale := math.Ldexp(1, p.BitDepth-1)
	low, high := -scale, scale-1
	for start := int64(0); start < document.Frames(); start += 4096 {
		count := int(min(int64(4096), document.Frames()-start))
		for ch := range pcm {
			if err := readCodecExportSamples(sources[ch], scratch[:count], start, p.Format, ch); err != nil {
				return protocol.DocumentExportInfo{}, err
			}
			pcm[ch] = pcm[ch][:count]
			for i, v := range scratch[:count] {
				if quantizers != nil {
					pcm[ch][i] = int32(quantizers[ch].ProcessInteger(float64(v))) // #nosec G115 -- exportQuantizers bounds signed output to the requested PCM depth of at most 32 bits.
				} else {
					pcm[ch][i] = int32(max(low, min(high, math.Round(float64(v)*scale))))
				}
			}
		}
		if err = write(pcm); err != nil {
			return protocol.DocumentExportInfo{}, fmt.Errorf("doc.export: encode %s: %w", p.Format, err)
		}
	}
	if err = closeEncoder(); err != nil {
		return protocol.DocumentExportInfo{}, fmt.Errorf("doc.export: finish %s: %w", p.Format, err)
	}
	e.bulkData = writer.data
	base := strings.TrimSuffix(document.Metadata().Name, filepath.Ext(document.Metadata().Name))
	if base == "" {
		base = "Untitled"
	}
	if p.Scope == "selection" {
		base += "-selection"
	}
	mime := "audio/flac"
	if p.Format == "aiff" {
		mime = "audio/aiff"
	}
	return protocol.DocumentExportInfo{Name: base + "." + p.Format, MimeType: mime, DataBytes: len(writer.data)}, nil
}

func readCodecExportSamples(source audiobuf.Channel, dst []float32, start int64, format string, channel int) error {
	if n := source.Read(dst, start); n != len(dst) {
		return fmt.Errorf("doc.export: %s channel %d read %d of %d frames: %w", format, channel, n, len(dst), io.ErrUnexpectedEOF)
	}
	return nil
}
