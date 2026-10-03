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
const Version = 4

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
	// MethodPeaksGet returns peak metadata with data retrieved via takeData.
	MethodPeaksGet = "peaks.get"
	// MethodDocumentOpen imports WAV bytes supplied separately from the JSON payload.
	MethodDocumentOpen = "doc.open"
	// MethodDocumentInfo returns the active document's format and dimensions.
	MethodDocumentInfo = "doc.info"
	// MethodDocumentExport encodes WAV bytes retrieved via takeData.
	MethodDocumentExport = "doc.export"
	// MethodTransportPlay starts document playback over a frame range.
	MethodTransportPlay = "transport.play"
	// MethodTransportStop preserves the cursor and stops rendering audio.
	MethodTransportStop = "transport.stop"
	// MethodTransportSeek changes the document playback cursor.
	MethodTransportSeek = "transport.seek"
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

// DocumentMemoryResult reports sample and cached peak storage, excluding
// metadata, block lists and runtime overhead. Shared blocks are counted once.
type DocumentMemoryResult struct {
	SampleBytes     int64 `json:"sampleBytes"`
	PeakBytes       int64 `json:"peakBytes"`
	UniqueBlocks    int   `json:"uniqueBlocks"`
	BlockReferences int   `json:"blockReferences"`
}

// PeaksGetParams selects a channel and viewport. Buckets is the desired pixel
// width, not an exact output count: the selected pyramid level supplies at
// least one summary per pixel, unless there are fewer source frames.
type PeaksGetParams struct {
	Channel    int   `json:"channel"`
	StartFrame int64 `json:"startFrame"`
	EndFrame   int64 `json:"endFrame"`
	Buckets    int   `json:"buckets"`
}

// PeaksGetInfo describes the transferable peak buffer. Cached buckets can
// extend beyond the requested viewport; their true positions let the UI clip
// them without sample processing. All fields in the buffer are little-endian:
// Count min/max/RMS float32 triples, Count uint32 frame counts, then Count
// float64 start frames. Total size is Count*24 bytes. JS wraps these regions in
// typed-array views; no audio or peak arrays are serialized as JSON.
type PeaksGetInfo struct {
	FramesPerBucket int64 `json:"framesPerBucket"`
	Count           int   `json:"count"`
	DataBytes       int   `json:"dataBytes"`
}

// DocumentOpenParams names WAV bytes passed as the bridge's binary argument.
type DocumentOpenParams struct {
	Name string `json:"name"`
}

// DocumentInfoResult describes the active document and its source encoding.
type DocumentInfoResult struct {
	Name       string `json:"name"`
	SampleRate int    `json:"sampleRate"`
	Channels   int    `json:"channels"`
	Frames     int64  `json:"frames"`
	BitDepth   int    `json:"bitDepth"`
	Float      bool   `json:"float"`
}

// DocumentExportParams selects the output encoding; Format must be "wav".
type DocumentExportParams struct {
	Format   string `json:"format"`
	BitDepth int    `json:"bitDepth"`
	Float    bool   `json:"float"`
}

// DocumentExportInfo describes a WAV binary result supplied through takeData.
type DocumentExportInfo struct {
	Name      string `json:"name"`
	MimeType  string `json:"mimeType"`
	DataBytes int    `json:"dataBytes"`
}

// TransportPlayParams selects a nonempty document range. A missing End uses
// the document's final frame. Loop repeats this range continuously.
type TransportPlayParams struct {
	Start int64  `json:"start"`
	End   *int64 `json:"end,omitempty"`
	Loop  bool   `json:"loop"`
}

// TransportSeekParams moves to a frame, including the document's final frame.
type TransportSeekParams struct {
	Frame int64 `json:"frame"`
}

// TransportResult reports the renderer's cursor. The audible cursor is taken
// from per-output-frame int64 position tags once the AudioWorklet consumes them.
type TransportResult struct {
	Start    int64 `json:"start"`
	End      int64 `json:"end"`
	Loop     bool  `json:"loop"`
	Position int64 `json:"position"`
	Playing  bool  `json:"playing"`
}
