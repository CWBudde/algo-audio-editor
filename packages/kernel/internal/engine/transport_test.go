package engine

import (
	"encoding/json"
	"math"
	"slices"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func transportEngine(t *testing.T, samples []float32, channels, sourceRate, outputRate int) *Engine {
	t.Helper()
	e := New()
	data := floatPayload(32, make([]float64, len(samples)))
	for i, sample := range samples {
		// Fixture serialization is independent of production sample processing.
		bits := math.Float32bits(sample)
		for byteIndex := range 4 {
			data[i*4+byteIndex] = byte(bits >> (8 * byteIndex))
		}
	}
	if _, err := e.openDocument(protocol.DocumentOpenParams{Name: "transport.wav"}, rawWAV(3, 32, channels, sourceRate, data, false)); err != nil {
		t.Fatal(err)
	}
	if _, err := e.configure(protocol.EngineConfigureParams{SampleRate: float64(outputRate), Channels: channels}); err != nil {
		t.Fatal(err)
	}
	return e
}

func playRange(t *testing.T, e *Engine, start, end int64, loop bool) protocol.TransportResult {
	t.Helper()
	result, err := e.playDocument(protocol.TransportPlayParams{Start: start, End: &end, Loop: loop})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestTransportRangeAndEOF(t *testing.T) {
	e := transportEngine(t, []float32{1, 2, 3, 4, 5}, 1, 48000, 48000)
	if state := playRange(t, e, 1, 4, false); state != (protocol.TransportResult{Start: 1, End: 4, Position: 1, Playing: true}) {
		t.Fatalf("play state %+v", state)
	}
	output := []float32{-7, -7, -7, -7, -7}
	positions := []int64{-7, -7, -7, -7, -7}
	if n := e.RenderWithPositions(output, positions); n != 3 {
		t.Fatalf("render wrote %d frames, want 3", n)
	}
	if !slices.Equal(output, []float32{2, 3, 4, 0, 0}) || !slices.Equal(positions, []int64{2, 3, 4, 0, 0}) {
		t.Fatalf("render samples %v positions %v", output, positions)
	}
	if e.transport.playing || e.transport.position != 4 {
		t.Fatalf("EOF state %+v", e.transport.result())
	}
	if e.RenderWithPositions(output, positions) != 0 || !slices.Equal(output, make([]float32, len(output))) {
		t.Fatal("EOF emitted audio again")
	}
}

func TestTransportLoopsAndStop(t *testing.T) {
	e := transportEngine(t, []float32{1, 2, 3, 4, 5}, 1, 48000, 48000)
	playRange(t, e, 1, 4, true)
	output, positions := make([]float32, 8), make([]int64, 8)
	if e.RenderWithPositions(output, positions) != 8 || !slices.Equal(output, []float32{2, 3, 4, 2, 3, 4, 2, 3}) || !slices.Equal(positions, []int64{2, 3, 1, 2, 3, 1, 2, 3}) {
		t.Fatalf("loop samples %v positions %v", output, positions)
	}
	if state := e.stopDocument(); state.Playing || state.Position != 3 || !state.Loop {
		t.Fatalf("stop state %+v", state)
	}
	if e.Render(output) != 0 || !slices.Equal(output, make([]float32, len(output))) {
		t.Fatal("stopped transport emitted audio")
	}
	if _, err := e.configureTone(protocol.ToneConfigureParams{FrequencyHz: 440, Amplitude: 0.2}); err != nil {
		t.Fatal(err)
	}
	if e.Render(output) != len(output) || e.source != sourceTone {
		t.Fatal("tone.configure did not restore diagnostic rendering")
	}
	e.stopDocument()
	if e.Render(output) != 0 {
		t.Fatal("stop did not stop diagnostic tone")
	}
}

func TestTransportSeekRangeAndEOF(t *testing.T) {
	e := transportEngine(t, []float32{1, 2, 3, 4, 5}, 1, 48000, 48000)
	playRange(t, e, 1, 4, true)
	state, err := e.seekDocument(protocol.TransportSeekParams{Frame: 2})
	if err != nil || state.Start != 1 || state.End != 4 || !state.Loop || !state.Playing || state.Position != 2 {
		t.Fatalf("selected seek: %+v, %v", state, err)
	}
	state, err = e.seekDocument(protocol.TransportSeekParams{Frame: 0})
	if err != nil || state.Start != 0 || state.End != 5 || !state.Loop || !state.Playing {
		t.Fatalf("outside seek: %+v, %v", state, err)
	}
	output := make([]float32, 1)
	if e.Render(output) != 1 || output[0] != 1 {
		t.Fatalf("seek output %v", output)
	}
	state, err = e.seekDocument(protocol.TransportSeekParams{Frame: 5})
	if err != nil || state.Playing || state.Position != 5 || e.Render(output) != 0 {
		t.Fatalf("EOF seek: %+v, %v", state, err)
	}
	state, err = e.seekDocument(protocol.TransportSeekParams{Frame: 1})
	if err != nil || state.Playing || state.Position != 1 {
		t.Fatalf("paused seek: %+v, %v", state, err)
	}
	empty := transportEngine(t, nil, 1, 48000, 48000)
	state, err = empty.seekDocument(protocol.TransportSeekParams{Frame: 0})
	if err != nil || state.Playing || state.End != 0 {
		t.Fatalf("empty seek: %+v, %v", state, err)
	}
}

func TestTransportRejectedCallsPreserveState(t *testing.T) {
	e := transportEngine(t, []float32{1, 2, 3, 4}, 1, 48000, 48000)
	playRange(t, e, 1, 4, true)
	before, source, ptr := e.transport.result(), e.source, e.transport
	for _, tt := range []struct {
		method, payload string
	}{
		{protocol.MethodTransportPlay, `{"start":-1,"end":2}`},
		{protocol.MethodTransportPlay, `{"start":2,"end":2}`},
		{protocol.MethodTransportPlay, `{"start":2,"end":1}`},
		{protocol.MethodTransportPlay, `{"start":0,"end":5}`},
		{protocol.MethodTransportPlay, `{"start":1.5}`},
		{protocol.MethodTransportPlay, `{"start":0,"end":9007199254740992}`},
		{protocol.MethodTransportSeek, `{"frame":-1}`},
		{protocol.MethodTransportSeek, `{"frame":5}`},
		{protocol.MethodTransportSeek, `{"frame":0.5}`},
		{protocol.MethodTransportSeek, "{"},
	} {
		response := call(t, e, tt.method, tt.payload)
		if response.OK || e.transport != ptr || e.source != source || e.transport.result() != before {
			t.Fatalf("rejected %s %s changed state: %+v", tt.method, tt.payload, response)
		}
	}
	if response := call(t, New(), protocol.MethodTransportPlay, `{"start":0}`); response.OK {
		t.Fatal("play without document accepted")
	}
	if response := call(t, New(), protocol.MethodTransportSeek, `{"frame":0}`); response.OK {
		t.Fatal("seek without document accepted")
	}
	if response := call(t, transportEngine(t, nil, 1, 48000, 48000), protocol.MethodTransportPlay, `{"start":0}`); response.OK {
		t.Fatal("play empty document accepted")
	}
}

func TestTransportRPCAndDocumentReplacement(t *testing.T) {
	e := transportEngine(t, []float32{1, 2, 3, 4}, 1, 48000, 48000)
	response := call(t, e, protocol.MethodTransportPlay, `{"start":1,"loop":true}`)
	var state protocol.TransportResult
	if !response.OK || json.Unmarshal(response.Result, &state) != nil || state.Start != 1 || state.End != 4 || !state.Playing || !state.Loop {
		t.Fatalf("play RPC %+v/%+v", response, state)
	}
	ptr := e.transport
	if _, err := e.openDocument(protocol.DocumentOpenParams{}, []byte("not a WAV")); err == nil || e.transport != ptr || !e.transport.playing {
		t.Fatal("failed document replacement stopped playback")
	}
	if _, err := e.openDocument(protocol.DocumentOpenParams{}, rawWAV(1, 16, 1, 48000, intPayload(16, []int32{123}), false)); err != nil {
		t.Fatal(err)
	}
	if e.transport != nil || e.source != sourceStopped || e.Render(make([]float32, 10)) != 0 {
		t.Fatal("successful document replacement did not stop playback")
	}
}

func TestDocumentFormatDoesNotDependOnInactiveDiagnosticFrequency(t *testing.T) {
	e := New()
	if _, err := e.configureTone(protocol.ToneConfigureParams{FrequencyHz: 17000, Amplitude: 0.3}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.configure(protocol.EngineConfigureParams{SampleRate: 8000, Channels: 1}); err == nil {
		t.Fatal("an active diagnostic above the new Nyquist was accepted")
	}
	if e.sampleRate != 48000 || e.channels != 2 || e.tone.frequency != 17000 || e.source != sourceTone {
		t.Fatal("rejected active diagnostic format changed state")
	}
	if _, err := e.openDocument(protocol.DocumentOpenParams{}, rawWAV(1, 16, 1, 8000, intPayload(16, []int32{8192, -8192}), false)); err != nil {
		t.Fatal(err)
	}
	if _, err := e.configure(protocol.EngineConfigureParams{SampleRate: 8000, Channels: 1}); err != nil {
		t.Fatalf("inactive diagnostic blocked a valid document format: %v", err)
	}
	if e.tone.frequency != defaultToneHz || e.tone.amplitude != 0.3 || e.source != sourceStopped {
		t.Fatal("inactive diagnostic reset changed source or amplitude")
	}
	playRange(t, e, 0, 2, false)
	before := e.transport.result()
	if _, err := e.configure(protocol.EngineConfigureParams{SampleRate: 4000, Channels: 1}); err == nil || e.transport.result() != before || e.source != sourceDocument {
		t.Fatal("invalid document format stopped playback")
	}
	output := make([]float32, 2)
	if e.Render(output) != 2 || !slices.Equal(output, []float32{0.25, -0.25}) {
		t.Fatalf("document output %v", output)
	}
}

func TestTransportSameRateBitExactChannelsAndBoundaries(t *testing.T) {
	bits := []uint32{0x80000000, 0, 0x7fc01234, 0x7f801234, 0x7f800000, 0xff800000, 1, 0x80000001, 0x3f000000}
	for _, channels := range []int{1, 2, 6, 8} {
		frames := audiobuf.BlockFrames + 19
		samples := make([]float32, frames*channels)
		for i := range samples {
			samples[i] = math.Float32frombits(bits[i%len(bits)])
		}
		e := transportEngine(t, samples, channels, 48000, 48000)
		start, end := int64(audiobuf.BlockFrames-17), int64(frames)
		playRange(t, e, start, end, false)
		output := make([]float32, int(end-start)*channels+channels-1)
		for i := int(end-start) * channels; i < len(output); i++ {
			output[i] = 123
		}
		positions := make([]int64, end-start)
		if n := e.RenderWithPositions(output, positions); n != int(end-start) {
			t.Fatalf("channels=%d rendered %d frames", channels, n)
		}
		for i := range int(end-start) * channels {
			if math.Float32bits(output[i]) != math.Float32bits(samples[int(start)*channels+i]) {
				t.Fatalf("channels=%d changed sample bits at %d", channels, i)
			}
		}
		for i, position := range positions {
			if position != start+int64(i)+1 {
				t.Fatalf("channels=%d position[%d]=%d", channels, i, position)
			}
		}
		for _, sample := range output[int(end-start)*channels:] {
			if sample != 123 {
				t.Fatal("render overwrote a trailing partial frame")
			}
		}
	}
}

func TestTransportLongOffsetsAndChannelMismatch(t *testing.T) {
	block, err := audiobuf.NewBlock([]float32{0.25})
	if err != nil {
		t.Fatal(err)
	}
	// Reusing a large immutable block models >2^31 frames with a small fixture.
	large, err := audiobuf.NewBlock(make([]float32, audiobuf.BlockFrames))
	if err != nil {
		t.Fatal(err)
	}
	blocks := make([]*audiobuf.Block, math.MaxInt32/audiobuf.BlockFrames+1)
	for i := range blocks {
		blocks[i] = large
	}
	blocks = append(blocks, block)
	channel, err := audiobuf.NewChannelFromBlocks(blocks)
	if err != nil {
		t.Fatal(err)
	}
	e := New()
	e.document, err = audiobuf.NewDocument([]audiobuf.Channel{channel}, 48000, audiobuf.Metadata{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.playDocument(protocol.TransportPlayParams{Start: channel.Frames() - 1}); err == nil {
		t.Fatal("mismatched render channel count accepted")
	}
	if _, err := e.configure(protocol.EngineConfigureParams{SampleRate: 48000, Channels: 1}); err != nil {
		t.Fatal(err)
	}
	playRange(t, e, channel.Frames()-1, channel.Frames(), false)
	output, positions := make([]float32, 1), make([]int64, 1)
	if e.RenderWithPositions(output, positions) != 1 || output[0] != 0.25 || positions[0] != channel.Frames() || positions[0] <= math.MaxInt32 {
		t.Fatalf("long-file render %v/%v", output, positions)
	}
}

func BenchmarkTransportRender(b *testing.B) {
	for _, channels := range []int{1, 2, 8} {
		b.Run(string(rune('0'+channels))+"channels", func(b *testing.B) {
			e := New()
			channel := audiobuf.NewChannel(make([]float32, 2*audiobuf.BlockFrames))
			data := make([]audiobuf.Channel, channels)
			for i := range data {
				data[i] = channel
			}
			var err error
			e.document, err = audiobuf.NewDocument(data, 48000, audiobuf.Metadata{})
			if err != nil {
				b.Fatal(err)
			}
			if _, err := e.configure(protocol.EngineConfigureParams{SampleRate: 48000, Channels: channels}); err != nil {
				b.Fatal(err)
			}
			if _, err := e.playDocument(protocol.TransportPlayParams{Loop: true}); err != nil {
				b.Fatal(err)
			}
			output, positions := make([]float32, 128*channels), make([]int64, 128)
			b.ReportAllocs()
			for b.Loop() {
				e.RenderWithPositions(output, positions)
			}
		})
	}
}
