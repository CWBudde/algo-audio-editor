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
const Version = 20

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
	MethodMetadataGet    = "metadata.get"
	MethodMetadataSet    = "metadata.set"
	// MethodPeaksGet returns peak metadata with data retrieved via takeData.
	MethodPeaksGet = "peaks.get"
	// MethodDocumentOpen imports detected audio bytes supplied separately from the JSON payload.
	MethodDocumentOpen    = "doc.open"
	MethodDocumentOpenPCM = "doc.openPCM"
	// MethodDocumentInfo returns the active document's format and dimensions.
	MethodDocumentInfo = "doc.info"
	// MethodDocumentExport encodes audio bytes retrieved via takeData.
	MethodDocumentExport = "doc.export"
	// MethodDocumentReadPCM copies a bounded planar float32 page for browser codecs.
	MethodDocumentReadPCM = "doc.readPCM"
	// MethodTransportPlay starts document playback over a frame range.
	MethodTransportPlay = "transport.play"
	// MethodTransportStop preserves the cursor and stops rendering audio.
	MethodTransportStop = "transport.stop"
	// MethodTransportSeek changes the document playback cursor.
	MethodTransportSeek          = "transport.seek"
	MethodSelectionGet           = "selection.get"
	MethodSelectionSet           = "selection.set"
	MethodSelectionSnap          = "selection.snap"
	MethodTimelineGet            = "timeline.get"
	MethodMarkersAdd             = "markers.add"
	MethodRegionsAdd             = "regions.add"
	MethodMarkersUpdate          = "markers.update"
	MethodMarkersRemove          = "markers.remove"
	MethodRegionsUpdate          = "regions.update"
	MethodRegionsRemove          = "regions.remove"
	MethodTimelineExport         = "timeline.export"
	MethodEditState              = "edit.state"
	MethodEditApply              = "edit.apply"
	MethodPreparePaste           = "edit.prepare-paste"
	MethodHistoryList            = "history.list"
	MethodHistoryJump            = "history.jump"
	MethodEditUndo               = "edit.undo"
	MethodEditRedo               = "edit.redo"
	MethodMarkSaved              = "doc.mark-saved"
	MethodProcessStart           = "process.start"
	MethodProcessStep            = "process.step"
	MethodProcessStepBatch       = "process.stepBatch"
	MethodProcessCancel          = "process.cancel"
	MethodProcessCommit          = "process.commit"
	MethodProcessExportCandidate = "process.exportCandidate"
	MethodDocumentImportBinary   = "doc.importBinary"
	MethodEffectsList            = "effects.list"
	MethodEffectsResponse        = "effects.response"
	MethodEffectsPreviewStart    = "effects.preview.start"
	MethodEffectsPreviewUpdate   = "effects.preview.update"
	MethodEffectsPreviewStop     = "effects.preview.stop"
	MethodEffectsPreviewMeters   = "effects.preview.meters"
	MethodEffectsApply           = "effects.apply"
	MethodEffectsIRLoad          = "effects.ir.load"
	MethodEffectsIRRemove        = "effects.ir.remove"
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
	Format     string `json:"format"`
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

// SelectionResult identifies a document and its current frame/channel selection.
type SelectionResult struct {
	DocumentID string `json:"documentId"`
	SelectionRange
}

// SelectionSetParams sets a document selection using the same shape as SelectionResult.
type SelectionSetParams = SelectionResult

// SelectionGetParams identifies the document whose selection is requested.
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

// SelectionSnapResult reports the nearest zero crossing and whether one was found.
type SelectionSnapResult struct {
	DocumentID string `json:"documentId"`
	Frame      int64  `json:"frame"`
	Found      bool   `json:"found"`
}

// TimelineMarker names a single document-frame anchor.
type TimelineMarker struct {
	ID    int64  `json:"id"`
	Frame int64  `json:"frame"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

// TimelineRegion names a half-open document-frame interval.
type TimelineRegion struct {
	ID    int64  `json:"id"`
	Start int64  `json:"start"`
	End   int64  `json:"end"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

// TimelineResult reports a document’s current markers and regions.
type TimelineResult struct {
	DocumentID string           `json:"documentId"`
	Markers    []TimelineMarker `json:"markers"`
	Regions    []TimelineRegion `json:"regions"`
}

// TimelineGetParams identifies the document whose annotations are requested.
type TimelineGetParams = SelectionGetParams

// TimelineMutationResult reports annotations and history after an annotation edit.
type TimelineMutationResult struct {
	TimelineResult
	History HistoryListResult `json:"history"`
	Changed bool              `json:"changed"`
}

// MarkerAddParams creates a marker and optionally updates the selection atomically.
type MarkerAddParams struct {
	DocumentID string          `json:"documentId"`
	Frame      int64           `json:"frame"`
	Name       string          `json:"name"`
	Color      string          `json:"color,omitempty"`
	Selection  *SelectionRange `json:"selection,omitempty"`
}

// RegionAddParams creates a region and optionally updates the selection atomically.
type RegionAddParams struct {
	DocumentID string          `json:"documentId"`
	Start      int64           `json:"start"`
	End        int64           `json:"end"`
	Name       string          `json:"name"`
	Color      string          `json:"color,omitempty"`
	Selection  *SelectionRange `json:"selection,omitempty"`
}

// MarkerUpdateParams replaces the properties of an existing marker.
type MarkerUpdateParams struct {
	MarkerAddParams
	ID int64 `json:"id"`
}

// RegionUpdateParams replaces the properties of an existing region.
type RegionUpdateParams struct {
	RegionAddParams
	ID int64 `json:"id"`
}

// TimelineRemoveParams removes an annotation by identity with an optional selection update.
type TimelineRemoveParams struct {
	DocumentID string          `json:"documentId"`
	ID         int64           `json:"id"`
	Selection  *SelectionRange `json:"selection,omitempty"`
}

// TimelineExportParams selects a document and annotation export format.
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
	Operation        OperationName `json:"operation"`
	Frames           *int64        `json:"frames,omitempty"`
	Convert          bool          `json:"convert,omitempty"`
	ClipboardVersion string        `json:"clipboardVersion,omitempty"`
}

// EditResult reports document, selection, clipboard and history after an edit.
type EditResult struct {
	Document  DocumentInfoResult `json:"document"`
	Selection SelectionResult    `json:"selection"`
	Timeline  TimelineResult     `json:"timeline"`
	Clipboard ClipboardInfo      `json:"clipboard"`
	Changed   bool               `json:"changed"`
	History   HistoryListResult  `json:"history"`
}

// ProcessStartParams builds a private candidate in bounded worker slices. Only commit
// publishes it; preview playback and cancellation leave the document unchanged.
type ProcessStartParams struct {
	SelectionResult
	Operation OperationName `json:"operation"`
	GainDB    float64       `json:"gainDb"`
	Target    *float64      `json:"target,omitempty"`
	// TruePeakCeiling (dBTP) caps loudness-normalization gain; nothing else accepts it.
	TruePeakCeiling *float64 `json:"truePeakCeiling,omitempty"`
	Curve           string   `json:"curve,omitempty"`
	DurationFrames  int64    `json:"durationFrames,omitempty"`
	ChannelMode     string   `json:"channelMode,omitempty"`
	Channel         int      `json:"channel,omitempty"`
	SampleRate      int      `json:"sampleRate,omitempty"`
	Quality         string   `json:"quality,omitempty"`
	Generator       string   `json:"generator,omitempty"`
	Frequency       float64  `json:"frequency,omitempty"`
	EndFrequency    float64  `json:"endFrequency,omitempty"`
	LevelDB         float64  `json:"levelDb,omitempty"`
	Seed            uint64   `json:"seed,omitempty"`
	// SourceSampleRate is the rate of the mono little-endian float32 PCM that
	// the "audio" generator takes as the call's binary input.
	SourceSampleRate int              `json:"sourceSampleRate,omitempty"`
	FFTSize          int              `json:"fftSize,omitempty"`
	SpectralMask     *SpectralMask    `json:"spectralMask,omitempty"`
	NoiseProfile     *SelectionResult `json:"noiseProfile,omitempty"`
	ReductionDB      float64          `json:"reductionDb,omitempty"`
	NoiseMethod      string           `json:"noiseMethod,omitempty"`
	Sensitivity      float64          `json:"sensitivity,omitempty"`
	ClipThreshold    float64          `json:"clipThreshold,omitempty"`
	MaxGap           int              `json:"maxGap,omitempty"`
	DurationRatio    float64          `json:"durationRatio,omitempty"`
	HumHz            float64          `json:"humHz,omitempty"`
	HumQ             float64          `json:"humQ,omitempty"`
	Harmonics        int              `json:"harmonics,omitempty"`
}

// ChainSpeechGenerate is the operation-chain method that speaks text and
// places it like the "audio" generator. It is not a kernel method: the UI and
// native runners synthesize with go-pocket-tts, then call process.start.
const ChainSpeechGenerate = "speech.generate"

// GeneratorAudio places the PCM passed with process.start: speech keeps its
// own length, resampled to the document rate.
const GeneratorAudio = "audio"

// MaxSpeechTextRunes bounds the text of one speech.generate step.
const MaxSpeechTextRunes = 5000

// SpeechGenerateParams are the parameters of a speech.generate chain step.
// Model and Voice name go-pocket-tts catalog entries; Seed reproduces the
// speech for one build, platform and worker count. LevelDB scales it.
type SpeechGenerateParams struct {
	SelectionResult
	Model        string  `json:"model"`
	Voice        string  `json:"voice"`
	Text         string  `json:"text"`
	Temperature  float64 `json:"temperature"`
	SamplerSteps int     `json:"samplerSteps"`
	EOSThreshold float64 `json:"eosThreshold"`
	Seed         uint64  `json:"seed"`
	LevelDB      float64 `json:"levelDb,omitempty"`
}

// SpectralPoint is selection geometry, never audio data.
type (
	SpectralPoint struct {
		Frame float64 `json:"frame"`
		Hz    float64 `json:"hz"`
	}
	// SpectralMask bounds a rectangle or a polygon in document-frame/Hz coordinates.
	SpectralMask struct {
		Start  int64           `json:"start"`
		End    int64           `json:"end"`
		LowHz  float64         `json:"lowHz"`
		HighHz float64         `json:"highHz"`
		Points []SpectralPoint `json:"points,omitempty"`
	}
)

// ProcessCandidate describes output geometry independently of source coordinates.
type ProcessCandidate struct {
	SampleRate int   `json:"sampleRate"`
	Channels   int   `json:"channels"`
	Frames     int64 `json:"frames"`
	SelectionRange
}

// BinaryDocumentParams accompanies planar little-endian float32 samples. It is
// used only for exact editor-window handoffs; samples never enter JSON.
type BinaryDocumentParams struct {
	Name         string            `json:"name"`
	Tags         map[string]string `json:"tags"`
	SampleRate   int               `json:"sampleRate"`
	Channels     int               `json:"channels"`
	Frames       int64             `json:"frames"`
	NextAnchorID int64             `json:"nextAnchorId"`
	Markers      []TimelineMarker  `json:"markers"`
	Regions      []TimelineRegion  `json:"regions"`
}

// BinaryDocumentInfo describes a binary document handoff and its separate sample buffer.
type BinaryDocumentInfo struct {
	BinaryDocumentParams
	DataBytes int `json:"dataBytes"`
}

// PCMReadParams requires a current history state and explicit source geometry.
// Frames is limited to 8192; channels are packed in ascending physical order.
type PCMReadParams struct {
	DocumentID  string `json:"documentId"`
	StateID     string `json:"stateId"`
	Start       int64  `json:"start"`
	Frames      int    `json:"frames"`
	ChannelMask int    `json:"channelMask"`
}

// PCMReadInfo describes the packed planar float32 page returned outside JSON.
type PCMReadInfo struct {
	SampleRate int `json:"sampleRate"`
	Channels   int `json:"channels"`
	Frames     int `json:"frames"`
	DataBytes  int `json:"dataBytes"`
}

// ProcessJobParams identifies a private processing job within a document.
type ProcessJobParams struct {
	DocumentID string `json:"documentId"`
	JobID      string `json:"jobId"`
}

// ProcessJobResult reports private candidate geometry, progress and measured quality.
type ProcessJobResult struct {
	SelectionResult
	Candidate       *ProcessCandidate `json:"candidate"`
	JobID           string            `json:"jobId"`
	State           JobState          `json:"state"`
	Operation       OperationName     `json:"operation"`
	GainDB          float64           `json:"gainDb"`
	ProcessedFrames int64             `json:"processedFrames"`
	TotalFrames     int64             `json:"totalFrames"`
	Peak            float64           `json:"peak"`
	NonFinite       bool              `json:"nonFinite"`
	Phase           ProcessPhase      `json:"phase"`
	PhaseIndex      int               `json:"phaseIndex"`
	PhaseCount      int               `json:"phaseCount"`
	GainResolved    bool              `json:"gainResolved"`
	PlanningSteps   int64             `json:"planningSteps"`
	InputPeak       float64           `json:"inputPeak"`
	InputLUFS       *float64          `json:"inputLufs"`
	PredictedLUFS   *float64          `json:"predictedLufs"`
	OutputLUFS      *float64          `json:"outputLufs"`
	Target          *float64          `json:"target,omitempty"`
	UnchangedReason string            `json:"unchangedReason,omitempty"`
	// TruePeakCeiling echoes the requested ceiling. TruePeak is the output's
	// 4x-oversampled linear maximum, set by normalization once its gain is
	// resolved. CeilingLimited reports that the ceiling lowered that gain.
	TruePeakCeiling *float64 `json:"truePeakCeiling,omitempty"`
	TruePeak        *float64 `json:"truePeak"`
	CeilingLimited  bool     `json:"ceilingLimited,omitempty"`
}

// HistoryListParams identifies the document whose history is requested.
type HistoryListParams struct {
	DocumentID string `json:"documentId"`
}

// HistoryJumpParams selects a retained history state to restore.
type HistoryJumpParams struct {
	DocumentID string `json:"documentId"`
	StateID    string `json:"stateId"`
}

// MarkSavedParams acknowledges successful saving of a specific history state.
type MarkSavedParams struct {
	DocumentID string `json:"documentId"`
	StateID    string `json:"stateId"`
}

// HistoryEntry identifies and labels a retained document state.
type HistoryEntry struct {
	StateID string `json:"stateId"`
	Label   string `json:"label"`
}

// HistoryListResult reports undo/redo availability, save state and retention limits.
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

// PreparePasteParams requests conversion planning for a specific clipboard version.
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

// DocumentExportParams selects the output encoding; Format is "wav", "flac" or "aiff".
// Missing Scope, Dither and NoiseShaping preserve whole-document/no-quality
// export. Selection uses the current authoritative range/channel mask. Seed
// optionally makes independent source-channel dither streams reproducible.
type DocumentExportParams struct {
	Format       string  `json:"format"`
	BitDepth     int     `json:"bitDepth"`
	Float        bool    `json:"float"`
	Scope        string  `json:"scope,omitempty"`
	Dither       string  `json:"dither,omitempty"`
	NoiseShaping string  `json:"noiseShaping,omitempty"`
	Seed         *uint32 `json:"seed,omitempty"`
	DocumentID   string  `json:"documentId,omitempty"`
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
	Start           int64  `json:"start"`
	End             *int64 `json:"end,omitempty"`
	Loop            bool   `json:"loop"`
	PreviewJobID    string `json:"previewJobId,omitempty"`
	EffectPreviewID string `json:"effectPreviewId,omitempty"`
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

// MetadataGetParams identifies the document whose metadata is requested.
// Editable fields are small UTF-8 text; opaque container bytes stay in Go.
type MetadataGetParams = SelectionGetParams

// MetadataResult reports editable text tags and retained opaque container data.
type MetadataResult struct {
	DocumentID     string            `json:"documentId"`
	StateID        string            `json:"stateId"`
	Tags           map[string]string `json:"tags"`
	PreservedBytes int               `json:"preservedBytes"`
	Chunks         []string          `json:"chunks"`
}

// MetadataSetParams replaces text tags for the specified current history state.
type MetadataSetParams struct {
	DocumentID string            `json:"documentId"`
	StateID    string            `json:"stateId"`
	Tags       map[string]string `json:"tags"`
}

// MetadataMutationResult reports metadata and history after a tag edit.
type MetadataMutationResult struct {
	MetadataResult
	History HistoryListResult `json:"history"`
	Changed bool              `json:"changed"`
}
