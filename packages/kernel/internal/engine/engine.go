// Package engine is the kernel's platform-independent core. It owns all state
// and implements every protocol method, so it can be tested natively; the
// js/wasm entry point in cmd/kernel only marshals values across syscall/js.
package engine

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
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
	memory         memoryBudget
	callInputBytes int64
	bulkData       []byte

	doc          documentSubsystem
	playback     transportSubsystem
	historyState historySubsystem
	jobs         jobSubsystem
	analysis     analysisSubsystem
	effectsState effectsSubsystem
}

// New returns an engine configured for 48 kHz stereo.
func New() *Engine {
	tone, err := newToneSource(defaultSampleRate, defaultToneHz, defaultToneAmp)
	if err != nil {
		// The defaults are constants; failing here is a programming error.
		panic(fmt.Sprintf("engine: default tone: %v", err))
	}

	return &Engine{playback: transportSubsystem{
		sampleRate: defaultSampleRate,
		channels:   defaultChannels,
		tone:       tone,
	}}
}

// SampleRate returns the current render sample rate in hertz.
func (e *Engine) SampleRate() float64 { return e.playback.sampleRate }

// Channels returns the current number of interleaved render channels.
func (e *Engine) Channels() int { return e.playback.channels }

// Call executes method with the JSON payload and returns the JSON-encoded
// protocol.Response. It never panics on bad input: every failure, including a
// malformed payload or an unknown method, becomes an error envelope.
func (e *Engine) Call(method string, payload []byte) []byte {
	return e.CallWithData(method, payload, nil)
}

// CallWithData supplies binary input separately from JSON control parameters.
// Import consumes the bytes during the call without retaining the input file.
func (e *Engine) CallWithData(method string, payload, input []byte) (response []byte) {
	defer func() {
		e.callInputBytes = 0
		if recovered := recover(); recovered != nil {
			e.bulkData = nil
			response = encodeResponse(protocol.Response{Error: fmt.Sprintf("%s: panic: %v", method, recovered)})
		}
	}()
	// Binary data belongs to exactly one call. A rejected or non-bulk call must
	// never expose a previous request's result.
	e.bulkData = nil
	e.callInputBytes = int64(len(input))
	if e.callInputBytes > 0 {
		if err := e.checkStorage(method, e.callInputBytes); err != nil {
			return encodeResponse(protocol.Response{Error: err.Error()})
		}
	}
	result, err := e.dispatch(method, payload, input)
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
	return e.RenderWithPositions(dst, nil)
}

func (e *Engine) documentMemory() protocol.DocumentMemoryResult {
	documents := []audiobuf.Document{e.doc.document}
	if e.historyState.history != nil {
		documents = nil
	}
	if job := e.jobs.processJob; job != nil {
		if job.builder != nil {
			if document, err := job.builder.MemoryDocument(); err == nil {
				documents = append(documents, document)
			}
		} else if job.candidate.Channels() > 0 {
			documents = append(documents, job.candidate)
		}
	}
	var stats audiobuf.MemoryStats
	if e.historyState.history != nil {
		stats = e.historyState.history.MemoryStats(documents, e.doc.clipboard.Windows()...)
	} else {
		stats = audiobuf.CountMemoryWithWindows(documents, e.doc.clipboard.Windows()...)
	}

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
		SampleRate:      e.playback.sampleRate,
		Channels:        e.playback.channels,
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
	stagedMeters := e.playback.meters
	if stagedMeters != nil && (stagedMeters.rate != p.SampleRate || stagedMeters.channels != p.Channels) {
		var err error
		stagedMeters, err = newPlaybackMeters(p.SampleRate, p.Channels)
		if err != nil {
			return protocol.EngineConfigureResult{}, fmt.Errorf("engine.configure: prepare meters: %w", err)
		}
	}

	frequency := e.playback.tone.frequency
	if e.playback.source != sourceTone && frequency >= p.SampleRate/2 {
		// An inactive diagnostic must not prevent a valid document render format.
		frequency = defaultToneHz
	}
	if err := e.playback.tone.configure(p.SampleRate, frequency, e.playback.tone.amplitude); err != nil {
		return protocol.EngineConfigureResult{}, fmt.Errorf("%s: %w", protocol.MethodEngineConfigure, err)
	}

	e.playback.sampleRate = p.SampleRate
	e.playback.channels = p.Channels
	e.playback.meters = stagedMeters
	e.analysis.spectrumHistory = nil
	e.analysis.spectrumWrite = 0
	e.analysis.spectrumCount = 0
	if e.playback.source == sourceDocument {
		e.stopDocument()
	}

	return protocol.EngineConfigureResult{SampleRate: e.playback.sampleRate, Channels: e.playback.channels}, nil
}

func (e *Engine) configureTone(p protocol.ToneConfigureParams) (protocol.ToneConfigureResult, error) {
	if err := e.playback.tone.configure(e.playback.sampleRate, p.FrequencyHz, p.Amplitude); err != nil {
		return protocol.ToneConfigureResult{}, fmt.Errorf("%s: %w", protocol.MethodToneConfigure, err)
	}
	if e.playback.transport != nil {
		e.playback.transport.playing = false
	}
	e.playback.source = sourceTone
	e.resetMeters()

	return protocol.ToneConfigureResult{FrequencyHz: e.playback.tone.frequency, Amplitude: e.playback.tone.amplitude}, nil
}

// decode accepts one JSON value, rejecting unknown fields at every struct
// level and any trailing value. Empty payloads retain default zero parameters;
// null remains accepted for callers of methods without control parameters.
func decode(method string, payload []byte, dst any) error {
	if len(bytes.TrimSpace(payload)) == 0 {
		return nil
	}

	d := json.NewDecoder(bytes.NewReader(payload))
	d.DisallowUnknownFields()
	if err := d.Decode(dst); err != nil {
		return fmt.Errorf("%s: decode params: %w", method, err)
	}
	if err := d.Decode(new(any)); err != io.EOF {
		if err == nil {
			return fmt.Errorf("%s: decode params: expected exactly one JSON value", method)
		}
		return fmt.Errorf("%s: decode params: trailing data: %w", method, err)
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
