package engine

import (
	"bytes"
	"encoding/binary"
	"io"
	"math"
	"slices"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

// rawWAV builds test containers independently of the production wav codec.
func rawWAV(tag, depth, channels, rate int, pcm []byte, extensible bool) []byte {
	fmtSize := 16
	if extensible {
		fmtSize = 40
	}
	data := make([]byte, 12+8+fmtSize+8+len(pcm)+(len(pcm)&1))
	copy(data[:4], "RIFF")
	binary.LittleEndian.PutUint32(data[4:8], uint32(len(data)-8))
	copy(data[8:16], "WAVEfmt ")
	binary.LittleEndian.PutUint32(data[16:20], uint32(fmtSize))
	format := data[20 : 20+fmtSize]
	formatTag := tag
	if extensible {
		formatTag = 0xfffe
	}
	binary.LittleEndian.PutUint16(format[:2], uint16(formatTag))
	binary.LittleEndian.PutUint16(format[2:4], uint16(channels))
	binary.LittleEndian.PutUint32(format[4:8], uint32(rate))
	binary.LittleEndian.PutUint32(format[8:12], uint32(rate*channels*(depth/8)))
	binary.LittleEndian.PutUint16(format[12:14], uint16(channels*(depth/8)))
	binary.LittleEndian.PutUint16(format[14:16], uint16(depth))
	if extensible {
		binary.LittleEndian.PutUint16(format[16:18], 22)
		binary.LittleEndian.PutUint16(format[18:20], uint16(depth))
		binary.LittleEndian.PutUint32(format[24:28], uint32(tag))
		copy(format[28:40], []byte{0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71})
	}
	copy(data[20+fmtSize:], "data")
	binary.LittleEndian.PutUint32(data[24+fmtSize:], uint32(len(pcm)))
	copy(data[28+fmtSize:], pcm)
	return data
}

func intPayload(depth int, samples []int32) []byte {
	data := make([]byte, len(samples)*(depth/8))
	for i, value := range samples {
		for byteIndex := range depth / 8 {
			data[i*(depth/8)+byteIndex] = byte(uint32(value) >> (8 * byteIndex))
		}
	}
	return data
}

func floatPayload(depth int, samples []float64) []byte {
	data := make([]byte, len(samples)*(depth/8))
	for i, value := range samples {
		if depth == 32 {
			binary.LittleEndian.PutUint32(data[i*4:], math.Float32bits(float32(value)))
		} else {
			binary.LittleEndian.PutUint64(data[i*8:], math.Float64bits(value))
		}
	}
	return data
}

func assertDocumentSamples(t *testing.T, engine *Engine, interleaved []float32, channels int) {
	t.Helper()
	if engine.document.Channels() != channels || engine.document.Frames() != int64(len(interleaved)/channels) {
		t.Fatalf("document shape %d/%d, expected %d/%d", engine.document.Channels(), engine.document.Frames(), channels, len(interleaved)/channels)
	}
	for i := range channels {
		channel, err := engine.document.Channel(i)
		if err != nil {
			t.Fatal(err)
		}
		got := make([]float32, len(interleaved)/channels)
		if n := channel.Read(got, 0); n != len(got) {
			t.Fatalf("channel %d read %d of %d frames", i, n, len(got))
		}
		for frame, value := range got {
			if math.Float32bits(value) != math.Float32bits(interleaved[frame*channels+i]) {
				t.Fatalf("channel %d frame %d = %v/%08x, want %v/%08x", i, frame, value, math.Float32bits(value), interleaved[frame*channels+i], math.Float32bits(interleaved[frame*channels+i]))
			}
		}
	}
}

func TestWAVPayloadRoundTrips(t *testing.T) {
	floatBits := []uint32{0x80000000, 0, 0x3f000000, 0xbf800000, 0x3f800000, 0x40000000, 0xc0400000, 0x7f800000, 0xff800000, 0x7fc01234, 0xffc05678, 0x7f801234, 1, 0x80000001}
	floatPCM := make([]byte, len(floatBits)*4)
	for i, bits := range floatBits {
		binary.LittleEndian.PutUint32(floatPCM[i*4:], bits)
	}
	for _, tt := range []struct {
		name    string
		depth   int
		float   bool
		payload []byte
	}{
		{"PCM16", 16, false, intPayload(16, []int32{-32768, -32767, -1, 0, 1, 1234, 32766, 32767})},
		{"PCM24", 24, false, intPayload(24, []int32{-8388608, -8388607, -1, 0, 1, 1234567, 8388606, 8388607})},
		{"float32", 32, true, floatPCM},
	} {
		t.Run(tt.name, func(t *testing.T) {
			tag := 1
			if tt.float {
				tag = 3
			}
			engine := &Engine{}
			info, err := engine.openDocument(protocol.DocumentOpenParams{Name: "golden.wav"}, rawWAV(tag, tt.depth, 2, 48000, tt.payload, false))
			if err != nil {
				t.Fatal(err)
			}
			if info.Name != "golden.wav" || info.BitDepth != tt.depth || info.Float != tt.float || info.SampleRate != 48000 {
				t.Fatalf("unexpected info %+v", info)
			}
			exported, err := engine.exportDocument(protocol.DocumentExportParams{Format: "wav", BitDepth: tt.depth, Float: tt.float})
			if err != nil {
				t.Fatal(err)
			}
			data := engine.TakeData()
			layout, err := inspectWAV(data)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(data[layout.dataStart:layout.dataStart+layout.dataBytes], tt.payload) {
				t.Fatalf("payload changed: got %x, want %x", data[layout.dataStart:layout.dataStart+layout.dataBytes], tt.payload)
			}
			if exported.Name != "golden.wav" || exported.MimeType != "audio/wav" || exported.DataBytes != len(data) {
				t.Fatalf("unexpected export info %+v", exported)
			}
		})
	}
}

func TestWAVImportFormatsAndChannels(t *testing.T) {
	for _, tt := range []struct {
		name       string
		tag, depth int
		extensible bool
		payload    []byte
		samples    []float32
	}{
		{"PCM8 odd data", 1, 8, false, []byte{0, 128, 255}, []float32{-1, 1.0 / 255, 1}},
		{"PCM32", 1, 32, false, intPayload(32, []int32{math.MinInt32, -1073741824, 0, 1073741824, math.MaxInt32}), []float32{-1, -0.5, 0, 0.5, 1}},
		{"float64", 3, 64, false, floatPayload(64, []float64{-2, -0.5, 0, 0.5, 2}), []float32{-2, -0.5, 0, 0.5, 2}},
		{"extensible PCM24", 1, 24, true, intPayload(24, []int32{-4194304, 0, 4194304}), []float32{-0.5, 0, 0.5}},
		{"extensible float32", 3, 32, true, floatPayload(32, []float64{-2, 0, 2}), []float32{-2, 0, 2}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			engine := &Engine{}
			input := rawWAV(tt.tag, tt.depth, 1, 44100, tt.payload, tt.extensible)
			info, err := engine.openDocument(protocol.DocumentOpenParams{}, input)
			if err != nil {
				t.Fatal(err)
			}
			if info.Frames != int64(len(tt.samples)) || info.Channels != 1 || info.Float != (tt.tag == 3) || info.Name != "Untitled.wav" {
				t.Fatalf("unexpected info %+v", info)
			}
			assertDocumentSamples(t, engine, tt.samples, 1)
			clear(input)
			assertDocumentSamples(t, engine, tt.samples, 1)
		})
	}
	for channels := 1; channels <= MaxChannels; channels++ {
		integers := make([]int32, 3*channels)
		want := make([]float32, len(integers))
		for i := range integers {
			integers[i] = int32(i * 137)
			want[i] = float32(integers[i]) / 32768
		}
		engine := &Engine{}
		if _, err := engine.openDocument(protocol.DocumentOpenParams{}, rawWAV(1, 16, channels, 48000, intPayload(16, integers), false)); err != nil {
			t.Fatal(err)
		}
		assertDocumentSamples(t, engine, want, channels)
	}
}

func TestWAVImportStreamsAcrossBlocks(t *testing.T) {
	integers := make([]int32, 2*(audiobuf.BlockFrames+17))
	want := make([]float32, len(integers))
	for i := range integers {
		integers[i] = int32(i%65536) - 32768
		want[i] = float32(integers[i]) / 32768
	}
	engine := &Engine{}
	if _, err := engine.openDocument(protocol.DocumentOpenParams{}, rawWAV(1, 16, 2, 48000, intPayload(16, integers), false)); err != nil {
		t.Fatal(err)
	}
	assertDocumentSamples(t, engine, want, 2)
	if memory := engine.documentMemory(); memory.UniqueBlocks != 4 {
		t.Fatalf("import created %d blocks, want 4", memory.UniqueBlocks)
	}
	if _, err := engine.exportDocument(protocol.DocumentExportParams{Format: "wav", BitDepth: 16}); err != nil {
		t.Fatal(err)
	}
	exported := engine.TakeData()
	layout, err := inspectWAV(exported)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(exported[layout.dataStart:layout.dataStart+layout.dataBytes], intPayload(16, integers)) {
		t.Fatal("streaming export changed payload")
	}
}

func TestWAVAncillaryChunksAndDataBeforeFormat(t *testing.T) {
	valid := rawWAV(1, 16, 1, 48000, intPayload(16, []int32{123, -456}), false)
	// Unknown list types remain opaque, but LIST now requires its type header.
	// Short/malformed metadata is rejected separately by metadata_test.go.
	ancillary := timelineRIFFChunk("LIST", []byte("zzzzopaque"))
	for _, reverse := range []bool{false, true} {
		input := slices.Clone(valid[:12])
		input = append(input, ancillary...)
		if reverse {
			input = append(input, valid[36:]...)
			input = append(input, valid[12:36]...)
		} else {
			input = append(input, valid[12:]...)
		}
		input = append(input, ancillary...)
		binary.LittleEndian.PutUint32(input[4:8], uint32(len(input)-8))
		engine := &Engine{}
		if _, err := engine.openDocument(protocol.DocumentOpenParams{}, input); err != nil {
			t.Fatalf("reverse=%t: %v", reverse, err)
		}
		assertDocumentSamples(t, engine, []float32{123.0 / 32768, -456.0 / 32768}, 1)
	}
	duplicate := append(slices.Clone(valid), valid[36:]...)
	binary.LittleEndian.PutUint32(duplicate[4:8], uint32(len(duplicate)-8))
	if _, err := (&Engine{}).openDocument(protocol.DocumentOpenParams{}, duplicate); err == nil {
		t.Fatal("multiple audio data chunks accepted")
	}
}

func TestWAVEmptyAndOddExport(t *testing.T) {
	for _, payload := range [][]byte{nil, {0, 128, 255}} {
		engine := &Engine{}
		info, err := engine.openDocument(protocol.DocumentOpenParams{Name: "odd"}, rawWAV(1, 8, 1, 48000, payload, false))
		if err != nil || info.Frames != int64(len(payload)) {
			t.Fatalf("open empty/odd: %+v, %v", info, err)
		}
		exported, err := engine.exportDocument(protocol.DocumentExportParams{Format: "wav", BitDepth: 8})
		if err != nil {
			t.Fatal(err)
		}
		data := engine.TakeData()
		layout, err := inspectWAV(data)
		if err != nil || layout.dataBytes != len(payload) || len(data) != 44+len(payload)+(len(payload)&1) || exported.Name != "odd.wav" {
			t.Fatalf("empty/odd export %x (%+v), error %v", data, exported, err)
		}
		if !bytes.Equal(data[layout.dataStart:layout.dataStart+layout.dataBytes], payload) {
			t.Fatal("odd payload changed")
		}
	}
}

func TestWAVRejectedOpenKeepsDocument(t *testing.T) {
	valid := rawWAV(1, 16, 1, 48000, intPayload(16, []int32{123, -456}), false)
	engine := &Engine{}
	before, err := engine.openDocument(protocol.DocumentOpenParams{Name: "original.wav"}, valid)
	if err != nil {
		t.Fatal(err)
	}
	fixtures := [][]byte{
		nil, []byte("not WAV"), valid[:35],
		rawWAV(1, 16, 2, 48000, []byte{1, 2}, false),
		rawWAV(1, 16, 0, 48000, nil, false),
		rawWAV(1, 16, 9, 48000, nil, false),
		rawWAV(1, 16, 1, 7999, nil, false),
		rawWAV(1, 16, 1, 384001, nil, false),
		rawWAV(6, 8, 1, 48000, []byte{1, 2}, false),
		rawWAV(1, 12, 1, 48000, []byte{1, 2}, false),
		rawWAV(3, 16, 1, 48000, []byte{1, 2}, false),
	}
	for _, field := range []struct {
		offset int
		value  uint32
	}{{4, 1}, {16, math.MaxUint32}, {28, 1}} {
		bad := slices.Clone(valid)
		binary.LittleEndian.PutUint32(bad[field.offset:], field.value)
		fixtures = append(fixtures, bad)
	}
	badGUID := rawWAV(1, 24, 1, 48000, []byte{0, 0, 0}, true)
	badGUID[59] ^= 1
	fixtures = append(fixtures, badGUID)
	for i, fixture := range fixtures {
		if _, err := engine.openDocument(protocol.DocumentOpenParams{Name: "rejected.wav"}, fixture); err == nil {
			t.Fatalf("invalid fixture %d accepted", i)
		}
		after, err := engine.documentInfo()
		if err != nil || after != before {
			t.Fatalf("invalid fixture %d changed document: %+v, %v", i, after, err)
		}
		assertDocumentSamples(t, engine, []float32{123.0 / 32768, -456.0 / 32768}, 1)
	}
}

func TestWAVExportValidation(t *testing.T) {
	engine := &Engine{}
	if _, err := engine.documentInfo(); err == nil {
		t.Fatal("absent document info accepted")
	}
	if _, err := engine.exportDocument(protocol.DocumentExportParams{Format: "wav", BitDepth: 16}); err == nil {
		t.Fatal("absent document export accepted")
	}
	if _, err := engine.openDocument(protocol.DocumentOpenParams{}, rawWAV(1, 16, 1, 48000, nil, false)); err != nil {
		t.Fatal(err)
	}
	for _, params := range []protocol.DocumentExportParams{
		{Format: "mp3", BitDepth: 16},
		{Format: "wav", BitDepth: 0},
		{Format: "wav", BitDepth: 12},
		{Format: "wav", BitDepth: 64},
		{Format: "wav", BitDepth: 16, Float: true},
	} {
		if _, err := engine.exportDocument(params); err == nil {
			t.Fatalf("invalid export %+v accepted", params)
		}
	}
	for _, params := range []protocol.DocumentExportParams{{Format: "wav", BitDepth: 32}, {Format: "wav", BitDepth: 64, Float: true}} {
		if _, err := engine.exportDocument(params); err != nil {
			t.Fatal(err)
		}
	}
}

func TestMemoryWriteSeekerBounds(t *testing.T) {
	writer := &memoryWriteSeeker{limit: 8}
	if n, err := writer.Write([]byte("abcd")); err != nil || n != 4 {
		t.Fatalf("write = %d, %v", n, err)
	}
	if _, err := writer.Seek(-2, io.SeekCurrent); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write([]byte("XY")); err != nil || string(writer.data) != "abXY" {
		t.Fatalf("overwrite = %q, %v", writer.data, err)
	}
	if _, err := writer.Seek(0, io.SeekEnd); err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		offset int64
		whence int
	}{{-1, io.SeekStart}, {5, io.SeekStart}, {1, io.SeekEnd}, {math.MaxInt64, io.SeekCurrent}, {math.MinInt64, io.SeekEnd}, {0, 99}} {
		if _, err := writer.Seek(tt.offset, tt.whence); err == nil || writer.pos != 4 {
			t.Fatalf("invalid seek %+v changed position to %d, error %v", tt, writer.pos, err)
		}
	}
	if n, err := writer.Write([]byte("12345")); err == nil || n != 0 || string(writer.data) != "abXY" {
		t.Fatalf("over-limit write = %d, %q, %v", n, writer.data, err)
	}
}

func TestWAVReadSeeker(t *testing.T) {
	reader := &wavReadSeeker{header: []byte("header"), data: []byte("audio")}
	buffer := make([]byte, 8)
	if n, err := reader.Read(buffer); n != 8 || err != nil || string(buffer) != "headerau" {
		t.Fatalf("read across segments = %d/%q, %v", n, buffer, err)
	}
	if _, err := reader.Seek(-2, io.SeekEnd); err != nil {
		t.Fatal(err)
	}
	if n, err := reader.Read(buffer); n != 2 || err != nil || string(buffer[:n]) != "io" {
		t.Fatalf("read tail = %d/%q, %v", n, buffer, err)
	}
	if n, err := reader.Read(buffer); n != 0 || err != io.EOF {
		t.Fatalf("EOF = %d, %v", n, err)
	}
	if n, err := reader.Read(nil); n != 0 || err != nil {
		t.Fatalf("empty read = %d, %v", n, err)
	}
	if _, err := reader.Seek(-1, io.SeekStart); err == nil {
		t.Fatal("negative read seek accepted")
	}
	if pos, err := reader.Seek(1, io.SeekStart); pos != 1 || err != nil {
		t.Fatalf("rewind = %d, %v", pos, err)
	}
}

func FuzzWAVOpen(f *testing.F) {
	f.Add(rawWAV(1, 16, 1, 48000, intPayload(16, []int32{0, 32767, -32768}), false))
	f.Add(rawWAV(1, 8, 1, 48000, []byte{0, 128, 255}, false))
	f.Add(rawWAV(3, 32, 2, 48000, floatPayload(32, []float64{0, -2, 2, 0.5}), true))
	f.Add([]byte("RIFF\xff\xff\xff\xffWAVE"))
	base := rawWAV(1, 16, 1, 48000, intPayload(16, []int32{0, 1, 2, 3}), false)
	f.Add(wavWithTimeline(
		base, true,
		timelineRIFFChunk("LIST", append([]byte("INFO"), timelineRIFFChunk("INAM", []byte("Recording\x00"))...)),
		timelineCue(7, 1), timelineADTL(timelineLabel(7, "Marker")),
		timelineRIFFChunk("bext", make([]byte, 602)),
	))
	f.Add(rf64Fixture(base, 4, nil))
	f.Fuzz(func(t *testing.T, input []byte) {
		if len(input) > 1<<20 {
			t.Skip()
		}
		engine := New()
		engine.memory.limit = 32 << 20
		info, err := engine.openDocument(protocol.DocumentOpenParams{Name: "fuzz.wav"}, input)
		if err != nil {
			if engine.document.Channels() != 0 {
				t.Fatal("failed open installed a document")
			}
			return
		}
		if info.Channels < 1 || info.Channels > 8 || info.SampleRate < MinSampleRate || info.SampleRate > MaxSampleRate || info.Frames < 0 {
			t.Fatalf("invalid imported info %+v", info)
		}
	})
}

func BenchmarkWAVImportTenMinuteStereo(b *testing.B) {
	const frames = 48000 * 600
	pcm := make([]byte, frames*2*2)
	for i := 0; i < len(pcm); i += 2 {
		binary.LittleEndian.PutUint16(pcm[i:], uint16(i/2))
	}
	input := rawWAV(1, 16, 2, 48000, pcm, false)
	pcm = nil
	b.ReportAllocs()
	b.SetBytes(int64(len(input)))
	for b.Loop() {
		engine := &Engine{}
		if info, err := engine.openDocument(protocol.DocumentOpenParams{Name: "ten-minutes.wav"}, input); err != nil || info.Frames != frames {
			b.Fatalf("import info %+v, error %v", info, err)
		}
	}
}
