// Package protocol defines the kernel's JS-facing ABI: method names, request
// and result payloads, and the response envelope.
//
// The TypeScript mirror lives in packages/protocol/src. The two are kept in
// sync by hand; any change here must be reflected there in the same commit,
// and Version must be bumped when an existing payload changes shape.
package protocol

import "encoding/json"

// Version is the ABI version. The frontend refuses to talk to a kernel whose
// Version differs from the one it was built against.
const Version = 1

// Method names accepted by the kernel's call entry point.
const (
	// MethodHello returns kernel identity and the ABI version.
	MethodHello = "hello"
	// MethodEngineConfigure sets the engine's sample rate and channel count.
	MethodEngineConfigure = "engine.configure"
	// MethodToneConfigure sets the test-tone frequency and amplitude.
	MethodToneConfigure = "tone.configure"
	// MethodDocumentMemory returns retained document sample storage statistics.
	MethodDocumentMemory = "doc.memory"
)

// Response is the envelope every call returns, serialized as JSON.
type Response struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
}

// HelloResult identifies the running kernel.
type HelloResult struct {
	ProtocolVersion int     `json:"protocolVersion"`
	KernelVersion   string  `json:"kernelVersion"`
	BuildTime       string  `json:"buildTime"`
	GoVersion       string  `json:"goVersion"`
	SampleRate      float64 `json:"sampleRate"`
	Channels        int     `json:"channels"`
}

// EngineConfigureParams sets the render format. Render output is interleaved
// float32 with Channels samples per frame.
type EngineConfigureParams struct {
	SampleRate float64 `json:"sampleRate"`
	Channels   int     `json:"channels"`
}

// EngineConfigureResult echoes the format the engine actually adopted.
type EngineConfigureResult struct {
	SampleRate float64 `json:"sampleRate"`
	Channels   int     `json:"channels"`
}

// ToneConfigureParams configures the Phase 0 test-tone source.
type ToneConfigureParams struct {
	FrequencyHz float64 `json:"frequencyHz"`
	Amplitude   float64 `json:"amplitude"`
}

// ToneConfigureResult echoes the adopted tone settings. FrequencyHz is rounded
// to whole hertz so the one-second wavetable loops without a phase jump.
type ToneConfigureResult struct {
	FrequencyHz float64 `json:"frequencyHz"`
	Amplitude   float64 `json:"amplitude"`
}

// DocumentMemoryResult reports sample storage, excluding metadata, block lists
// and runtime overhead. Shared blocks are counted only once.
type DocumentMemoryResult struct {
	SampleBytes     int64 `json:"sampleBytes"`
	UniqueBlocks    int   `json:"uniqueBlocks"`
	BlockReferences int   `json:"blockReferences"`
}
