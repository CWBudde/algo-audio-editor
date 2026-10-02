// Package engine is the kernel's platform-independent core. It owns all state
// and implements every protocol method, so it can be tested natively; the
// js/wasm entry point in cmd/kernel only marshals values across syscall/js.
package engine

import (
	"encoding/json"
	"fmt"
	"math"
	"runtime"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/buildinfo"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

// Limits on the render format accepted by engine.configure.
const (
	MinSampleRate = 8000
	MaxSampleRate = 384000
	MaxChannels   = 8
)

const (
	defaultSampleRate = 48000
	defaultChannels   = 2
	defaultToneHz     = 440
	defaultToneAmp    = 0.2
)

// Engine holds the kernel state. It is not safe for concurrent use; the
// kernel runs on a single worker thread and is driven from one event loop.
type Engine struct {
	sampleRate float64
	channels   int
	tone       *toneSource
	document   audiobuf.Document
	bulkData   []byte
}

// New returns an engine configured for 48 kHz stereo.
func New() *Engine {
	tone, err := newToneSource(defaultSampleRate, defaultToneHz, defaultToneAmp)
	if err != nil {
		// The defaults are constants; failing here is a programming error.
		panic(fmt.Sprintf("engine: default tone: %v", err))
	}

	return &Engine{
		sampleRate: defaultSampleRate,
		channels:   defaultChannels,
		tone:       tone,
	}
}

// SampleRate returns the current render sample rate in hertz.
func (e *Engine) SampleRate() float64 { return e.sampleRate }

// Channels returns the current number of interleaved render channels.
func (e *Engine) Channels() int { return e.channels }

// Call executes method with the JSON payload and returns the JSON-encoded
// protocol.Response. It never panics on bad input: every failure, including a
// malformed payload or an unknown method, becomes an error envelope.
func (e *Engine) Call(method string, payload []byte) []byte {
	// Binary data belongs to exactly one call. A rejected or non-bulk call must
	// never expose a previous request's result.
	e.bulkData = nil
	result, err := e.dispatch(method, payload)
	if err != nil {
		return encodeResponse(protocol.Response{Error: err.Error()})
	}

	raw, err := json.Marshal(result)
	if err != nil {
		return encodeResponse(protocol.Response{Error: fmt.Sprintf("%s: encode result: %v", method, err)})
	}

	return encodeResponse(protocol.Response{OK: true, Result: raw})
}

// TakeData transfers ownership of the preceding call's binary result. Calling
// it twice returns no data the second time. The JS bridge copies these bytes
// into a transferable ArrayBuffer; bulk data never enters the JSON envelope.
func (e *Engine) TakeData() []byte {
	data := e.bulkData
	e.bulkData = nil

	return data
}

// Render fills dst with interleaved frames in the current channel layout and
// returns the number of frames written. A trailing partial frame is left
// untouched.
func (e *Engine) Render(dst []float32) int {
	frames := len(dst) / e.channels
	e.tone.render(dst[:frames*e.channels], e.channels)

	return frames
}

func (e *Engine) dispatch(method string, payload []byte) (any, error) {
	switch method {
	case protocol.MethodHello:
		return e.hello(), nil
	case protocol.MethodDocumentMemory:
		return e.documentMemory(), nil
	case protocol.MethodPeaksGet:
		var p protocol.PeaksGetParams
		if err := decode(method, payload, &p); err != nil {
			return nil, err
		}

		return e.getPeaks(p)
	case protocol.MethodEngineConfigure:
		var p protocol.EngineConfigureParams
		if err := decode(method, payload, &p); err != nil {
			return nil, err
		}

		return e.configure(p)
	case protocol.MethodToneConfigure:
		var p protocol.ToneConfigureParams
		if err := decode(method, payload, &p); err != nil {
			return nil, err
		}

		return e.configureTone(p)
	default:
		return nil, fmt.Errorf("unknown method %q", method)
	}
}

func (e *Engine) documentMemory() protocol.DocumentMemoryResult {
	stats := audiobuf.CountMemory(e.document)

	return protocol.DocumentMemoryResult{
		SampleBytes: stats.SampleBytes, PeakBytes: stats.PeakBytes,
		UniqueBlocks: stats.UniqueBlocks, BlockReferences: stats.BlockReferences,
	}
}

func (e *Engine) hello() protocol.HelloResult {
	return protocol.HelloResult{
		ProtocolVersion: protocol.Version,
		KernelVersion:   buildinfo.Version,
		BuildTime:       buildinfo.BuildTime,
		GoVersion:       runtime.Version(),
		SampleRate:      e.sampleRate,
		Channels:        e.channels,
	}
}

func (e *Engine) configure(p protocol.EngineConfigureParams) (protocol.EngineConfigureResult, error) {
	if p.SampleRate != math.Trunc(p.SampleRate) || p.SampleRate < MinSampleRate || p.SampleRate > MaxSampleRate {
		return protocol.EngineConfigureResult{}, fmt.Errorf(
			"%s: sample rate %v must be an integer in [%d, %d]",
			protocol.MethodEngineConfigure, p.SampleRate, MinSampleRate, MaxSampleRate,
		)
	}

	if p.Channels < 1 || p.Channels > MaxChannels {
		return protocol.EngineConfigureResult{}, fmt.Errorf(
			"%s: channels %d must be in [1, %d]", protocol.MethodEngineConfigure, p.Channels, MaxChannels,
		)
	}

	if err := e.tone.configure(p.SampleRate, e.tone.frequency, e.tone.amplitude); err != nil {
		return protocol.EngineConfigureResult{}, fmt.Errorf("%s: %w", protocol.MethodEngineConfigure, err)
	}

	e.sampleRate = p.SampleRate
	e.channels = p.Channels

	return protocol.EngineConfigureResult{SampleRate: e.sampleRate, Channels: e.channels}, nil
}

func (e *Engine) configureTone(p protocol.ToneConfigureParams) (protocol.ToneConfigureResult, error) {
	if err := e.tone.configure(e.sampleRate, p.FrequencyHz, p.Amplitude); err != nil {
		return protocol.ToneConfigureResult{}, fmt.Errorf("%s: %w", protocol.MethodToneConfigure, err)
	}

	return protocol.ToneConfigureResult{FrequencyHz: e.tone.frequency, Amplitude: e.tone.amplitude}, nil
}

// decode unmarshals payload into dst. An empty payload leaves dst at its zero
// value, which the per-method validation then rejects where that matters.
func decode(method string, payload []byte, dst any) error {
	if len(payload) == 0 {
		return nil
	}

	if err := json.Unmarshal(payload, dst); err != nil {
		return fmt.Errorf("%s: decode params: %w", method, err)
	}

	return nil
}

func encodeResponse(r protocol.Response) []byte {
	out, err := json.Marshal(r)
	if err != nil {
		// Response holds only strings, a bool and pre-encoded JSON, so this
		// can only fail if Result is invalid JSON, which Call never produces.
		return []byte(`{"ok":false,"error":"internal: encode response"}`)
	}

	return out
}
