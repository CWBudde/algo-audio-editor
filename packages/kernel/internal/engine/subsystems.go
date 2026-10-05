package engine

import (
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/history"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

// Subsystems are values owned by one Engine. Cross-subsystem transactions stay
// on the coordinator, so staging, commit and cancellation share one event loop.
// None of these containers introduces synchronization or render allocations.
type documentSubsystem struct {
	document          audiobuf.Document
	sourceBitDepth    int
	sourceFloat       bool
	sourceFormat      string
	documentSequence  uint64
	editor            editorState
	clipboard         ops.Clipboard
	clipboardSequence uint64
}

type transportSubsystem struct {
	sampleRate float64
	channels   int
	tone       *toneSource
	source     renderSource
	transport  *documentTransport
	meters     *playbackMeters
}

type historySubsystem struct {
	history *history.History[historySnapshot]
}

type jobSubsystem struct {
	processJob       *processingJob
	processSequence  uint64
	cancelledProcess *protocol.ProcessJobResult
}

type analysisSubsystem struct {
	analysisJob                  *analysisJob
	analysisSequence             uint64
	cancelledAnalysis            *protocol.AnalysisJobResult
	analysisCache                []analysisTileCache
	spectrumHistory              []float32
	spectrumJob                  *playbackSpectrumJob
	spectrumWrite, spectrumCount int
}

type effectsSubsystem struct {
	effectPreview    *effectPreviewSession
	effectSequence   uint64
	impulseResponses map[int]impulseResponse
	impulseSequence  int
	impulseBytes     int64
}
