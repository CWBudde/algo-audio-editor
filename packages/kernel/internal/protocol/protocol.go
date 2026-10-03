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
const Version = 8

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
	MethodTransportSeek  = "transport.seek"
	MethodSelectionGet   = "selection.get"
	MethodSelectionSet   = "selection.set"
	MethodSelectionSnap  = "selection.snap"
	MethodTimelineGet    = "timeline.get"
	MethodMarkersAdd     = "markers.add"
	MethodRegionsAdd     = "regions.add"
	MethodMarkersUpdate  = "markers.update"
	MethodMarkersRemove  = "markers.remove"
	MethodRegionsUpdate  = "regions.update"
	MethodRegionsRemove  = "regions.remove"
	MethodTimelineExport = "timeline.export"
	MethodEditState      = "edit.state"
	MethodEditApply      = "edit.apply"
	MethodPreparePaste   = "edit.prepare-paste"
	MethodHistoryList    = "history.list"
	MethodHistoryJump    = "history.jump"
	MethodEditUndo       = "edit.undo"
	MethodEditRedo       = "edit.redo"
	MethodMarkSaved      = "doc.mark-saved"
	MethodProcessStart   = "process.start"
	MethodProcessStep    = "process.step"
	MethodProcessCancel  = "process.cancel"
	MethodProcessCommit  = "process.commit"
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
	DocumentID string `json:"documentId"`
	Name       string `json:"name"`
	SampleRate int    `json:"sampleRate"`
	Channels   int    `json:"channels"`
	Frames     int64  `json:"frames"`
	BitDepth   int    `json:"bitDepth"`
	Float      bool   `json:"float"`
}

// SelectionRange is a document-frame range and a nonzero channel bit mask.
// Equal endpoints represent a cursor; bit zero selects the first channel.
type SelectionRange struct {
	Start       int64 `json:"start"`
	End         int64 `json:"end"`
	ChannelMask int   `json:"channelMask"`
}

type SelectionResult struct {
	DocumentID string `json:"documentId"`
	SelectionRange
}

type SelectionSetParams = SelectionResult

type SelectionGetParams struct {
	DocumentID string `json:"documentId"`
}

// SelectionSnapParams queries a nearest zero crossing without changing selection.
// Radius is inclusive and limited to 8192 document frames.
type SelectionSnapParams struct {
	DocumentID  string `json:"documentId"`
	Frame       int64  `json:"frame"`
	Radius      int64  `json:"radius"`
	ChannelMask int    `json:"channelMask"`
}

type SelectionSnapResult struct {
	DocumentID string `json:"documentId"`
	Frame      int64  `json:"frame"`
	Found      bool   `json:"found"`
}

type TimelineMarker struct {
	ID    int64  `json:"id"`
	Frame int64  `json:"frame"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

type TimelineRegion struct {
	ID    int64  `json:"id"`
	Start int64  `json:"start"`
	End   int64  `json:"end"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

type TimelineResult struct {
	DocumentID string           `json:"documentId"`
	Markers    []TimelineMarker `json:"markers"`
	Regions    []TimelineRegion `json:"regions"`
}

type TimelineGetParams = SelectionGetParams

type TimelineMutationResult struct {
	TimelineResult
	History HistoryListResult `json:"history"`
	Changed bool              `json:"changed"`
}

type MarkerAddParams struct {
	DocumentID string          `json:"documentId"`
	Frame      int64           `json:"frame"`
	Name       string          `json:"name"`
	Color      string          `json:"color,omitempty"`
	Selection  *SelectionRange `json:"selection,omitempty"`
}

type RegionAddParams struct {
	DocumentID string          `json:"documentId"`
	Start      int64           `json:"start"`
	End        int64           `json:"end"`
	Name       string          `json:"name"`
	Color      string          `json:"color,omitempty"`
	Selection  *SelectionRange `json:"selection,omitempty"`
}

type MarkerUpdateParams struct {
	MarkerAddParams
	ID int64 `json:"id"`
}

type RegionUpdateParams struct {
	RegionAddParams
	ID int64 `json:"id"`
}

type TimelineRemoveParams struct {
	DocumentID string          `json:"documentId"`
	ID         int64           `json:"id"`
	Selection  *SelectionRange `json:"selection,omitempty"`
}

type TimelineExportParams struct {
	DocumentID string `json:"documentId"`
	Format     string `json:"format"`
}

// ClipboardInfo describes retained, compactly packed selected source channels.
type ClipboardInfo struct {
	Version    string `json:"version"`
	Available  bool   `json:"available"`
	SampleRate int    `json:"sampleRate"`
	Channels   int    `json:"channels"`
	Frames     int64  `json:"frames"`
}

// EditApplyParams supplies the complete range atomically, independently of
// queued selection.set calls. Paste needs the inspected clipboard version;
// channel or rate conversion additionally requires explicit Convert consent.
type EditApplyParams struct {
	SelectionResult
	Operation        string `json:"operation"`
	Frames           *int64 `json:"frames,omitempty"`
	Convert          bool   `json:"convert,omitempty"`
	ClipboardVersion string `json:"clipboardVersion,omitempty"`
}

type EditResult struct {
	Document  DocumentInfoResult `json:"document"`
	Selection SelectionResult    `json:"selection"`
	Timeline  TimelineResult     `json:"timeline"`
	Clipboard ClipboardInfo      `json:"clipboard"`
	Changed   bool               `json:"changed"`
	History   HistoryListResult  `json:"history"`
}

// Processing builds a private candidate in bounded worker slices. Only commit
// publishes it; preview playback and cancellation leave the document unchanged.
type ProcessStartParams struct {
	SelectionResult
	Operation string  `json:"operation"`
	GainDB    float64 `json:"gainDb"`
}

type ProcessJobParams struct {
	DocumentID string `json:"documentId"`
	JobID      string `json:"jobId"`
}

type ProcessJobResult struct {
	SelectionResult
	JobID           string  `json:"jobId"`
	State           string  `json:"state"`
	Operation       string  `json:"operation"`
	GainDB          float64 `json:"gainDb"`
	ProcessedFrames int64   `json:"processedFrames"`
	TotalFrames     int64   `json:"totalFrames"`
	Peak            float64 `json:"peak"`
	NonFinite       bool    `json:"nonFinite"`
}

type HistoryListParams struct {
	DocumentID string `json:"documentId"`
}

type HistoryJumpParams struct {
	DocumentID string `json:"documentId"`
	StateID    string `json:"stateId"`
}

type MarkSavedParams struct {
	DocumentID string `json:"documentId"`
	StateID    string `json:"stateId"`
}

type HistoryEntry struct {
	StateID string `json:"stateId"`
	Label   string `json:"label"`
}

type HistoryListResult struct {
	DocumentID     string         `json:"documentId"`
	CurrentStateID string         `json:"currentStateId"`
	SavedStateID   string         `json:"savedStateId"`
	Dirty          bool           `json:"dirty"`
	CanUndo        bool           `json:"canUndo"`
	CanRedo        bool           `json:"canRedo"`
	Entries        []HistoryEntry `json:"entries"`
	MaxEntries     int            `json:"maxEntries"`
	MaxBytes       int64          `json:"maxBytes"`
	RetainedBytes  int64          `json:"retainedBytes"`
}

type PreparePasteParams struct {
	DocumentID       string `json:"documentId"`
	ChannelMask      int    `json:"channelMask"`
	ClipboardVersion string `json:"clipboardVersion"`
}

// PastePlan reports converted duration and the formats requiring confirmation.
// Conversion duplicates mono, averages N-to-mono, folds N>M channels cyclically
// with per-target equal weights, and duplicates cyclically when M>N.
type PastePlan struct {
	ConversionRequired bool   `json:"conversionRequired"`
	SourceRate         int    `json:"sourceRate"`
	TargetRate         int    `json:"targetRate"`
	SourceChannels     int    `json:"sourceChannels"`
	TargetChannels     int    `json:"targetChannels"`
	Frames             int64  `json:"frames"`
	ClipboardVersion   string `json:"clipboardVersion"`
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
	Start        int64  `json:"start"`
	End          *int64 `json:"end,omitempty"`
	Loop         bool   `json:"loop"`
	PreviewJobID string `json:"previewJobId,omitempty"`
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
