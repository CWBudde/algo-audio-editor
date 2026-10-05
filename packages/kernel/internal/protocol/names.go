package protocol

// OperationName is a control operation's wire name. Edit and processing
// payloads retain their existing JSON spelling; validation still rejects names
// outside the applicable operation family.
type OperationName string

// Operation wire names identify supported edits and processing algorithms.
const (
	OperationCopy              OperationName = "copy"
	OperationCut               OperationName = "cut"
	OperationDelete            OperationName = "delete"
	OperationCrop              OperationName = "crop"
	OperationMute              OperationName = "mute"
	OperationInsertSilence     OperationName = "insert-silence"
	OperationDuplicate         OperationName = "duplicate"
	OperationSwapChannels      OperationName = "swap-channels"
	OperationPasteInsert       OperationName = "paste-insert"
	OperationPasteReplace      OperationName = "paste-replace"
	OperationPasteMix          OperationName = "paste-mix"
	OperationGain              OperationName = "gain"
	OperationNormalizePeak     OperationName = "normalize-peak"
	OperationNormalizeLoudness OperationName = "normalize-loudness"
	OperationFadeIn            OperationName = "fade-in"
	OperationFadeOut           OperationName = "fade-out"
	OperationCrossfade         OperationName = "crossfade"
	OperationReverse           OperationName = "reverse"
	OperationInvert            OperationName = "invert"
	OperationRemoveDC          OperationName = "remove-dc"
	OperationMonoToStereo      OperationName = "mono-to-stereo"
	OperationStereoToMono      OperationName = "stereo-to-mono"
	OperationExtractChannel    OperationName = "extract-channel"
	OperationResample          OperationName = "resample"
	OperationGenerate          OperationName = "generate"
	OperationSpectralAttenuate OperationName = "spectral-attenuate"
	OperationSpectralRemove    OperationName = "spectral-remove"
	OperationSpectralHeal      OperationName = "spectral-heal"
	OperationNoiseReduce       OperationName = "noise-reduce"
	OperationRemoveClicks      OperationName = "remove-clicks"
	OperationDeclip            OperationName = "declip"
	OperationTimeStretch       OperationName = "time-stretch"
	OperationRemoveHum         OperationName = "remove-hum"
	OperationEffects           OperationName = "effects"
)

// AnalysisKind identifies the algorithm and its binary result layout.
type AnalysisKind string

// Analysis kinds identify the kernel’s measurement and visualization algorithms.
const (
	AnalysisStatistics  AnalysisKind = "statistics"
	AnalysisClipping    AnalysisKind = "clipping"
	AnalysisPitch       AnalysisKind = "pitch"
	AnalysisSpectrum    AnalysisKind = "spectrum"
	AnalysisSpectrogram AnalysisKind = "spectrogram"
)

// JobState describes a private candidate or analysis job's lifecycle.
type JobState string

// Job states describe progress, completed candidates and cancellation.
const (
	JobRunning   JobState = "running"
	JobReady     JobState = "ready"
	JobCancelled JobState = "cancelled"
)

// ProcessPhase identifies normalization and processing progress stages.
type ProcessPhase string

// Processing phases distinguish input analysis, construction and output verification.
const (
	PhaseAnalyzing  ProcessPhase = "analyzing"
	PhaseProcessing ProcessPhase = "processing"
	PhaseVerifying  ProcessPhase = "verifying"
)
