package engine

import (
	"encoding/json"
	"math"
	"strings"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func call(t *testing.T, e *Engine, method, payload string) protocol.Response {
	t.Helper()

	var resp protocol.Response
	if err := json.Unmarshal(e.Call(method, []byte(payload)), &resp); err != nil {
		t.Fatalf("Call(%q) returned invalid JSON: %v", method, err)
	}

	return resp
}

func TestHello(t *testing.T) {
	resp := call(t, New(), protocol.MethodHello, "")
	if !resp.OK {
		t.Fatalf("hello failed: %s", resp.Error)
	}

	var got protocol.HelloResult
	if err := json.Unmarshal(resp.Result, &got); err != nil {
		t.Fatal(err)
	}

	if got.ProtocolVersion != protocol.Version {
		t.Errorf("ProtocolVersion = %d, want %d", got.ProtocolVersion, protocol.Version)
	}

	if got.SampleRate != defaultSampleRate || got.Channels != defaultChannels {
		t.Errorf("format = %v Hz / %d ch, want %d / %d", got.SampleRate, got.Channels, defaultSampleRate, defaultChannels)
	}

	if !strings.HasPrefix(got.GoVersion, "go") {
		t.Errorf("GoVersion = %q", got.GoVersion)
	}
}

func TestDocumentMemory(t *testing.T) {
	e := New()
	channel := audiobuf.NewChannel(make([]float32, audiobuf.BlockFrames+17))
	document, err := audiobuf.NewDocument([]audiobuf.Channel{channel, channel}, 48000, audiobuf.Metadata{})
	if err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		name string
		doc  audiobuf.Document
		want protocol.DocumentMemoryResult
	}{
		{"no document", audiobuf.Document{}, protocol.DocumentMemoryResult{}},
		{"shared stereo", document, protocol.DocumentMemoryResult{
			SampleBytes: (audiobuf.BlockFrames + 17) * 4, UniqueBlocks: 2, BlockReferences: 4,
		}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			e.document = tt.doc
			resp := call(t, e, protocol.MethodDocumentMemory, "")
			if !resp.OK {
				t.Fatalf("doc.memory: %s", resp.Error)
			}
			var got protocol.DocumentMemoryResult
			if err := json.Unmarshal(resp.Result, &got); err != nil {
				t.Fatal(err)
			}
			if got != tt.want {
				t.Fatalf("doc.memory = %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestCallErrors(t *testing.T) {
	tests := []struct {
		name, method, payload, wantErr string
	}{
		{"unknown method", "nope", "", `unknown method "nope"`},
		{"malformed payload", protocol.MethodEngineConfigure, "{", "decode params"},
		{"empty configure", protocol.MethodEngineConfigure, "", "sample rate 0"},
		{"fractional rate", protocol.MethodEngineConfigure, `{"sampleRate":44100.5,"channels":2}`, "must be an integer"},
		{"rate too low", protocol.MethodEngineConfigure, `{"sampleRate":4000,"channels":2}`, "sample rate 4000"},
		{"rate too high", protocol.MethodEngineConfigure, `{"sampleRate":768000,"channels":2}`, "sample rate 768000"},
		{"no channels", protocol.MethodEngineConfigure, `{"sampleRate":48000,"channels":0}`, "channels 0"},
		{"too many channels", protocol.MethodEngineConfigure, `{"sampleRate":48000,"channels":9}`, "channels 9"},
		{"tone above nyquist", protocol.MethodToneConfigure, `{"frequencyHz":24000,"amplitude":0.5}`, "outside"},
		{"tone zero", protocol.MethodToneConfigure, `{"frequencyHz":0,"amplitude":0.5}`, "outside"},
		{"tone loud", protocol.MethodToneConfigure, `{"frequencyHz":440,"amplitude":1.5}`, "amplitude"},
		{"tone negative", protocol.MethodToneConfigure, `{"frequencyHz":440,"amplitude":-0.1}`, "amplitude"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resp := call(t, New(), tt.method, tt.payload)
			if resp.OK {
				t.Fatalf("expected failure, got ok with %s", resp.Result)
			}

			if !strings.Contains(resp.Error, tt.wantErr) {
				t.Errorf("error = %q, want it to contain %q", resp.Error, tt.wantErr)
			}
		})
	}
}

func TestFailedConfigureKeepsState(t *testing.T) {
	e := New()
	call(t, e, protocol.MethodEngineConfigure, `{"sampleRate":4000,"channels":1}`)

	if e.SampleRate() != defaultSampleRate || e.Channels() != defaultChannels {
		t.Fatalf("rejected configure changed format to %v / %d", e.SampleRate(), e.Channels())
	}
}

func TestConfigureAndRender(t *testing.T) {
	tests := []struct {
		rate     float64
		channels int
	}{
		{44100, 1},
		{48000, 2},
		{96000, 6},
	}

	for _, tt := range tests {
		e := New()

		resp := call(t, e, protocol.MethodEngineConfigure,
			mustJSON(t, protocol.EngineConfigureParams{SampleRate: tt.rate, Channels: tt.channels}))
		if !resp.OK {
			t.Fatalf("configure %v/%d: %s", tt.rate, tt.channels, resp.Error)
		}

		// A buffer with a trailing partial frame (impossible for mono): the
		// remainder must stay untouched.
		const frames = 256

		partial := tt.channels - 1
		buf := make([]float32, frames*tt.channels+partial)

		for i := frames * tt.channels; i < len(buf); i++ {
			buf[i] = 42
		}

		if got := e.Render(buf); got != frames {
			t.Errorf("Render frames = %d, want %d", got, frames)
		}

		for i := frames * tt.channels; i < len(buf); i++ {
			if buf[i] != 42 {
				t.Fatalf("Render wrote past the last whole frame at %d", i)
			}
		}

		for f := range frames {
			for c := 1; c < tt.channels; c++ {
				if buf[f*tt.channels+c] != buf[f*tt.channels] {
					t.Fatalf("frame %d: channel %d differs from channel 0", f, c)
				}
			}
		}
	}
}

// The tone must be phase-continuous across render calls and across the
// wavetable wrap point: rendering in odd-sized chunks has to produce exactly
// the same stream as one large render, and that stream must match an ideal
// sine.
func TestToneContinuity(t *testing.T) {
	const (
		rate  = 48000
		total = rate + 5000 // crosses the one-second table wrap
		freq  = 997.0
		amp   = 0.5
	)

	newMono := func() *Engine {
		e := New()
		call(t, e, protocol.MethodEngineConfigure, `{"sampleRate":48000,"channels":1}`)
		call(t, e, protocol.MethodToneConfigure, mustJSON(t, protocol.ToneConfigureParams{FrequencyHz: freq, Amplitude: amp}))

		return e
	}

	whole := make([]float32, total)
	newMono().Render(whole)

	chunked := make([]float32, 0, total)
	e := newMono()

	for len(chunked) < total {
		n := min(333, total-len(chunked))
		buf := make([]float32, n)
		e.Render(buf)
		chunked = append(chunked, buf...)
	}

	for i := range total {
		if chunked[i] != whole[i] {
			t.Fatalf("sample %d: chunked %v != whole %v", i, chunked[i], whole[i])
		}

		want := amp * math.Sin(2*math.Pi*freq*float64(i)/rate)
		if math.Abs(float64(whole[i])-want) > 1e-6 {
			t.Fatalf("sample %d = %v, want %v", i, whole[i], want)
		}
	}
}

func TestToneFrequencyIsRounded(t *testing.T) {
	resp := call(t, New(), protocol.MethodToneConfigure, `{"frequencyHz":440.4,"amplitude":0.1}`)
	if !resp.OK {
		t.Fatal(resp.Error)
	}

	var got protocol.ToneConfigureResult
	if err := json.Unmarshal(resp.Result, &got); err != nil {
		t.Fatal(err)
	}

	if got.FrequencyHz != 440 {
		t.Errorf("FrequencyHz = %v, want 440", got.FrequencyHz)
	}
}

func BenchmarkRender(b *testing.B) {
	e := New()
	buf := make([]float32, 128*2)

	b.ReportAllocs()

	for b.Loop() {
		e.Render(buf)
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()

	out, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}

	return string(out)
}
