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
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/history"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
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
	sampleRate        float64
	channels          int
	tone              *toneSource
	document          audiobuf.Document
	bulkData          []byte
	sourceBitDepth    int
	sourceFloat       bool
	source            renderSource
	transport         *documentTransport
	documentSequence  uint64
	editor            editorState
	clipboard         ops.Clipboard
	clipboardSequence uint64
	history           *history.History[historySnapshot]
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
	return e.CallWithData(method, payload, nil)
}

// CallWithData supplies binary input separately from JSON control parameters.
// Import consumes the bytes during the call without retaining the input file.
func (e *Engine) CallWithData(method string, payload, input []byte) []byte {
	// Binary data belongs to exactly one call. A rejected or non-bulk call must
	// never expose a previous request's result.
	e.bulkData = nil
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

func (e *Engine) dispatch(method string, payload, input []byte) (any, error) {
	switch method {
	case protocol.MethodHello:
		return e.hello(), nil
	case protocol.MethodDocumentMemory:
		return e.documentMemory(), nil
	case protocol.MethodDocumentInfo:
		return e.documentInfo()
	case protocol.MethodEditState:
		return e.clipboardInfo(), nil
	case protocol.MethodHistoryList, protocol.MethodEditUndo, protocol.MethodEditRedo:
		var p protocol.HistoryListParams
		if err := decode(method, payload, &p); err != nil {
			return nil, err
		}
		if method == protocol.MethodHistoryList {
			return e.listHistory(p)
		}
		return e.navigateHistory(method, p.DocumentID, "")
	case protocol.MethodHistoryJump:
		var p protocol.HistoryJumpParams
		if err := decode(method, payload, &p); err != nil {
			return nil, err
		}
		return e.navigateHistory(method, p.DocumentID, p.StateID)
	case protocol.MethodMarkSaved:
		var p protocol.MarkSavedParams
		if err := decode(method, payload, &p); err != nil {
			return nil, err
		}
		return e.markSaved(p)
	case protocol.MethodEditApply:
		var p protocol.EditApplyParams
		if err := decode(method, payload, &p); err != nil {
			return nil, err
		}
		return e.applyEdit(p)
	case protocol.MethodPreparePaste:
		var p protocol.PreparePasteParams
		if err := decode(method, payload, &p); err != nil {
			return nil, err
		}
		return e.preparePaste(p)
	case protocol.MethodSelectionGet, protocol.MethodSelectionSet, protocol.MethodSelectionSnap,
		protocol.MethodTimelineGet, protocol.MethodMarkersAdd, protocol.MethodRegionsAdd:
		return e.dispatchEditor(method, payload)
	case protocol.MethodDocumentOpen:
		var p protocol.DocumentOpenParams
		if err := decode(method, payload, &p); err != nil {
			return nil, err
		}

		return e.openDocument(p, input)
	case protocol.MethodDocumentExport:
		var p protocol.DocumentExportParams
		if err := decode(method, payload, &p); err != nil {
			return nil, err
		}

		return e.exportDocument(p)
	case protocol.MethodTransportPlay:
		var p protocol.TransportPlayParams
		if err := decode(method, payload, &p); err != nil {
			return nil, err
		}
		return e.playDocument(p)
	case protocol.MethodTransportStop:
		return e.stopDocument(), nil
	case protocol.MethodTransportSeek:
		var p protocol.TransportSeekParams
		if err := decode(method, payload, &p); err != nil {
			return nil, err
		}
		return e.seekDocument(p)
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
	documents := []audiobuf.Document{e.document}
	if e.history != nil {
		documents = e.history.Documents()
	}
	stats := audiobuf.CountMemoryWithWindows(documents, e.clipboard.Windows()...)

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

	frequency := e.tone.frequency
	if e.source != sourceTone && frequency >= p.SampleRate/2 {
		// An inactive diagnostic must not prevent a valid document render format.
		frequency = defaultToneHz
	}
	if err := e.tone.configure(p.SampleRate, frequency, e.tone.amplitude); err != nil {
		return protocol.EngineConfigureResult{}, fmt.Errorf("%s: %w", protocol.MethodEngineConfigure, err)
	}

	e.sampleRate = p.SampleRate
	e.channels = p.Channels
	if e.source == sourceDocument {
		e.stopDocument()
	}

	return protocol.EngineConfigureResult{SampleRate: e.sampleRate, Channels: e.channels}, nil
}

func (e *Engine) configureTone(p protocol.ToneConfigureParams) (protocol.ToneConfigureResult, error) {
	if err := e.tone.configure(e.sampleRate, p.FrequencyHz, p.Amplitude); err != nil {
		return protocol.ToneConfigureResult{}, fmt.Errorf("%s: %w", protocol.MethodToneConfigure, err)
	}
	if e.transport != nil {
		e.transport.playing = false
	}
	e.source = sourceTone

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
