package process

import (
	"context"
	"errors"
	"fmt"
	"math"
	"math/bits"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	"github.com/cwbudde/algo-dsp/dsp/signal"
	"github.com/cwbudde/algo-dsp/measure/loudness"
)

const normalizationPlanWork = 4096

// NormalizationStatus contains control metadata only. Nullable LUFS metrics
// represent genuinely undefined measurements; no NaN/Inf enters the protocol.
type NormalizationStatus struct {
	Phase           string
	PhaseIndex      int
	PhaseCount      int
	GainResolved    bool
	PlanningSteps   int64
	GainDB          float64
	InputPeak       float64
	InputLUFS       *float64
	PredictedLUFS   *float64
	OutputLUFS      *float64
	UnchangedReason string
}

// Normalizer first measures a linked selected program, delegates all gain and
// loudness algorithms upstream, then materializes immutable output using Builder.
// Selected channels are packed in source order with the same explicit BS.1770
// mapping used by statistics and playback meters.
type Normalizer struct {
	source         audiobuf.Document
	selected       ops.Range
	operation      string
	target         float64
	limits         Limits
	channels       []audiobuf.Channel
	storage        []float32
	block          [][]float32
	feed           audiobuf.TargetFeedBuffer
	analyzer       *loudness.TargetAnalyzer
	verification   *loudness.TargetAnalyzer
	builder        *Builder
	result         audiobuf.Document
	status         NormalizationStatus
	progress       Progress
	peak           float64
	identity       bool
	verifyInput    bool
	observedOutput bool
	failure        error
}

// NewNormalizer prepares bounded analysis only. No new output sample blocks or
// per-output block tables exist until a valid linked gain has been resolved.
func NewNormalizer(document audiobuf.Document, selected ops.Range, operation string, target float64, limits Limits) (*Normalizer, error) {
	if err := validate(document, selected, LinearGain{Factor: 1}, limits); err != nil {
		return nil, fmt.Errorf("process.normalize: %w", err)
	}
	if operation != "normalize-peak" && operation != "normalize-loudness" {
		return nil, fmt.Errorf("process.normalize: unsupported operation %q", operation)
	}
	minimum := -120.0
	if operation == "normalize-loudness" {
		minimum = -69
	}
	if math.IsNaN(target) || math.IsInf(target, 0) || target < minimum || target > 0 {
		return nil, fmt.Errorf("process.normalize: target must be finite in [%g, 0]", minimum)
	}
	count := bits.OnesCount(uint(selected.ChannelMask))
	n := &Normalizer{
		source: document, selected: selected, operation: operation, target: target, limits: limits,
		channels: make([]audiobuf.Channel, 0, count), status: NormalizationStatus{Phase: "analyzing", PhaseCount: 2},
		progress: Progress{FramesTotal: selected.End - selected.Start},
	}
	if operation == "normalize-loudness" {
		n.storage = make([]float32, count*audiobuf.BlockFrames)
		n.block = make([][]float32, count)
		indices := make([]int, 0, count)
		for channel := range document.Channels() {
			if selected.ChannelMask&(1<<channel) != 0 {
				indices = append(indices, channel)
			}
		}
		weights, err := loudness.BS1770ChannelWeights(document.Channels(), indices)
		if err != nil {
			return nil, fmt.Errorf("process.normalize: channel weights: %w", err)
		}
		analyzer, err := loudness.NewTargetAnalyzer(loudness.IntegratedConfig{
			SampleRate: float64(document.SampleRate()), Channels: count, ChannelWeights: weights, MaxFrames: n.progress.FramesTotal,
		}, target)
		if err != nil {
			return nil, fmt.Errorf("process.normalize: prepare loudness analysis: %w", err)
		}
		n.analyzer = analyzer
		n.status.PhaseCount = 3
	}
	for channel := range document.Channels() {
		if selected.ChannelMask&(1<<channel) == 0 {
			continue
		}
		source, err := document.Channel(channel)
		if err != nil {
			return nil, fmt.Errorf("process.normalize: read channel %d: %w", channel, err)
		}
		n.channels = append(n.channels, source)
	}
	return n, nil
}

// Status returns phase-aware control metadata without exposing audio samples.
func (n *Normalizer) Status() NormalizationStatus { return n.status }

// Progress reports current phase work without advancing the candidate.
func (n *Normalizer) Progress() Progress { return n.progress }

// Identity distinguishes a resolved no-op from the initially unresolved 0 dB.
func (n *Normalizer) Identity() bool { return n.identity }

// MaterializedBytes reserves a possible gain pass even before analysis resolves
// whether normalization changes the source.
func (n *Normalizer) MaterializedBytes() int64 {
	return (n.selected.End - n.selected.Start) * 4 * int64(bits.OnesCount(uint(n.selected.ChannelMask)))
}

// Peak returns finite OUTPUT amplitude; input amplitude is separate telemetry.
func (n *Normalizer) Peak() (float64, bool) { return n.peak, false }

// Step performs one <=BlockFrames scan/render, or bounded upstream planning.
func (n *Normalizer) Step(ctx context.Context) (Progress, error) {
	if n.failure != nil {
		return n.progress, n.failure
	}
	if n.progress.Done {
		return n.progress, nil
	}
	if ctx == nil {
		return n.fail(fmt.Errorf("process.normalize: nil context"))
	}
	if err := ctx.Err(); err != nil {
		return n.fail(fmt.Errorf("process.normalize: %w", err))
	}
	switch n.status.Phase {
	case "analyzing":
		return n.analyze(ctx)
	case "processing":
		return n.materialize(ctx)
	case "verifying":
		return n.verify(ctx)
	default:
		return n.fail(fmt.Errorf("process.normalize: invalid phase"))
	}
}

func (n *Normalizer) readBlock(ctx context.Context, frames int) error {
	for channel := range n.channels {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("process.normalize: %w", err)
		}
		start := channel * audiobuf.BlockFrames
		n.block[channel] = n.storage[start : start+frames]
		if count := n.channels[channel].Read(n.block[channel], n.selected.Start+n.progress.FramesDone); count != frames {
			return fmt.Errorf("process.normalize: read %d of %d frames", count, frames)
		}
	}
	return nil
}

func (n *Normalizer) processLoudnessBlock(ctx context.Context, analyzer *loudness.TargetAnalyzer, frames int) error {
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("process.normalize: %w", err)
	}
	// The concrete feed adapter certifies only finiteness and exact sample peak
	// from immutable storage. Both source and candidate still undergo actual
	// independent K filtering, complete-window accumulation and gated analysis.
	fed, err := n.feed.Feed(analyzer, n.channels, n.selected.Start+n.progress.FramesDone, frames)
	if err != nil {
		return fmt.Errorf("process.normalize: feed loudness: %w", err)
	}
	if !fed {
		if err := n.readBlock(ctx, frames); err != nil {
			return err
		}
		if err := analyzer.ProcessPlanar32(n.block); err != nil {
			return fmt.Errorf("process.normalize: analyze copied range: %w", err)
		}
	}
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("process.normalize: %w", err)
	}
	return nil
}

func (n *Normalizer) analyze(ctx context.Context) (Progress, error) {
	if n.progress.FramesDone < n.progress.FramesTotal {
		frames := int(min(int64(audiobuf.BlockFrames), n.progress.FramesTotal-n.progress.FramesDone))
		if n.analyzer != nil {
			if err := n.processLoudnessBlock(ctx, n.analyzer, frames); err != nil {
				return n.fail(fmt.Errorf("process.normalize: analyze loudness: %w", err))
			}
			n.status.InputPeak = n.analyzer.SamplePeak()
		} else {
			start := n.selected.Start + n.progress.FramesDone
			for _, channel := range n.channels {
				if err := ctx.Err(); err != nil {
					return n.fail(fmt.Errorf("process.normalize: %w", err))
				}
				peak, err := channel.FinitePeak(start, start+int64(frames))
				if err != nil {
					if errors.Is(err, audiobuf.ErrNonFiniteSamples) {
						return n.fail(fmt.Errorf("process.normalize: read peak: %v: %w", err, loudness.ErrNonFinite))
					}
					return n.fail(fmt.Errorf("process.normalize: read peak: %w", err))
				}
				n.status.InputPeak = math.Max(n.status.InputPeak, peak)
			}
		}
		n.progress.FramesDone += int64(frames)
		return n.progress, nil
	}
	// A genuinely silent program cannot be amplified. Keep its signed zeros and
	// original document/storage exactly, without inventing a loudness reading.
	if n.operation == "normalize-loudness" && n.progress.FramesTotal < int64(math.Round(float64(n.source.SampleRate())*4/10)) {
		return n.fail(fmt.Errorf("process.normalize: %w", loudness.ErrTooShort))
	}
	if n.status.InputPeak == 0 {
		n.identity, n.status.GainResolved, n.progress.Done = true, true, true
		n.status.UnchangedReason = "silent"
		n.status.PhaseIndex = n.status.PhaseCount - 1
		n.status.Phase = "processing"
		if n.status.PhaseCount == 3 {
			n.status.Phase = "verifying"
		}
		n.result = n.source
		n.releaseAnalysis()
		return n.progress, nil
	}
	if n.analyzer == nil {
		plan, err := signal.PlanPeakNormalization(n.status.InputPeak, n.target)
		if err != nil {
			return n.fail(fmt.Errorf("process.normalize: plan peak: %w", err))
		}
		return n.startBuilder(plan.GainDB, plan.Gain)
	}
	done, err := n.analyzer.FinishStep(normalizationPlanWork)
	n.status.PlanningSteps++
	if err != nil {
		return n.fail(fmt.Errorf("process.normalize: plan loudness: %w", err))
	}
	if !done {
		return n.progress, nil
	}
	result, err := n.analyzer.Result()
	if err != nil {
		return n.fail(fmt.Errorf("process.normalize: loudness plan result: %w", err))
	}
	if math.IsNaN(result.PredictedLUFS) || math.IsInf(result.PredictedLUFS, 0) ||
		(result.HasMeasuredLUFS && (math.IsNaN(result.MeasuredLUFS) || math.IsInf(result.MeasuredLUFS, 0))) {
		return n.fail(fmt.Errorf("process.normalize: nonfinite loudness plan"))
	}
	if result.HasMeasuredLUFS {
		measured := result.MeasuredLUFS
		n.status.InputLUFS = &measured
	}
	predicted := result.PredictedLUFS
	n.status.PredictedLUFS = &predicted
	// Every nonsilent LUFS candidate is independently measured after rounding.
	// Reset preserves the bounded workspace but discards all input filter/gate
	// state and the plan; telemetry above already owns its scalar values.
	n.verifyInput = true
	n.verification = n.analyzer
	n.verification.Reset()
	return n.startBuilder(result.Plan.GainDB, result.Plan.Gain)
}

func (n *Normalizer) startBuilder(db, coefficient float64) (Progress, error) {
	if math.IsNaN(db) || math.IsInf(db, 0) || math.IsNaN(coefficient) || math.IsInf(coefficient, 0) || coefficient <= 0 {
		return n.fail(fmt.Errorf("process.normalize: invalid resolved gain"))
	}
	builder, err := NewBuilder(n.source, n.selected, LinearGain{Factor: coefficient}, n.limits)
	if err != nil {
		return n.fail(fmt.Errorf("process.normalize: prepare output: %w", err))
	}
	n.builder = builder
	n.identity = builder.Identity()
	if n.verification != nil && !n.identity {
		if err := builder.ObserveLoudness(n.verification); err != nil {
			return n.fail(fmt.Errorf("process.normalize: observe output: %w", err))
		}
		n.observedOutput = true
	}
	n.status.GainDB, n.status.GainResolved = db, true
	n.status.Phase, n.status.PhaseIndex = "processing", 1
	n.progress.FramesDone = 0
	n.releaseAnalysis()
	return n.progress, nil
}

func (n *Normalizer) releaseAnalysis() {
	n.analyzer = nil
	// Retain source channels/scratch only when a candidate verification scan
	// will be required. Otherwise the output builder owns its bounded scratch.
	if !n.verifyInput {
		n.channels, n.storage, n.block = nil, nil, nil
	}
}

func (n *Normalizer) materialize(ctx context.Context) (Progress, error) {
	progress, err := n.builder.Step(ctx)
	if err != nil {
		return n.fail(fmt.Errorf("process.normalize: render output: %w", err))
	}
	n.progress.FramesDone = progress.FramesDone
	peak, nonfinite := n.builder.Peak()
	if nonfinite || math.IsNaN(peak) || math.IsInf(peak, 0) {
		return n.fail(fmt.Errorf("process.normalize: output must be finite"))
	}
	n.peak = peak
	if !progress.Done {
		return n.progress, nil
	}
	result, err := n.builder.Result()
	if err != nil {
		return n.fail(fmt.Errorf("process.normalize: output result: %w", err))
	}
	n.result = result
	n.builder.Cancel()
	n.builder = nil
	if n.status.PhaseCount == 2 {
		n.progress.Done = true
		return n.progress, nil
	}
	n.status.Phase, n.status.PhaseIndex = "verifying", 2
	n.progress.FramesDone = 0
	if n.observedOutput {
		// The actual stored-output scan ran alongside materialization. The
		// verifying phase performs only bounded measurement finalization.
		n.progress.FramesDone = n.progress.FramesTotal
		n.channels, n.storage, n.block = nil, nil, nil
		return n.progress, nil
	}
	if !n.verifyInput {
		return n.progress, nil
	}
	// Identity candidates have no newly stored blocks. Scan the unchanged
	// immutable candidate with the reset independent measurement state.
	packed := 0
	for channel := range result.Channels() {
		if n.selected.ChannelMask&(1<<channel) == 0 {
			continue
		}
		n.channels[packed], err = result.Channel(channel)
		if err != nil {
			return n.fail(fmt.Errorf("process.normalize: verification channel: %w", err))
		}
		packed++
	}
	return n.progress, nil
}

func (n *Normalizer) verify(ctx context.Context) (Progress, error) {
	if !n.verifyInput {
		if n.status.PredictedLUFS == nil || math.Abs(*n.status.PredictedLUFS-n.target) > 0.01 {
			return n.fail(fmt.Errorf("process.normalize: predicted target is inaccurate"))
		}
		n.progress.FramesDone, n.progress.Done = n.progress.FramesTotal, true
		return n.progress, nil
	}
	if n.progress.FramesDone < n.progress.FramesTotal {
		frames := int(min(int64(audiobuf.BlockFrames), n.progress.FramesTotal-n.progress.FramesDone))
		if err := n.processLoudnessBlock(ctx, n.verification, frames); err != nil {
			return n.fail(fmt.Errorf("process.normalize: verify output: %w", err))
		}
		n.progress.FramesDone += int64(frames)
		return n.progress, nil
	}
	done, err := n.verification.FinishMeasurementStep(normalizationPlanWork)
	n.status.PlanningSteps++
	if err != nil {
		return n.fail(fmt.Errorf("process.normalize: finish verification: %w", err))
	}
	if !done {
		return n.progress, nil
	}
	result, err := n.verification.MeasurementResult()
	if err != nil {
		return n.fail(fmt.Errorf("process.normalize: verification result: %w", err))
	}
	if math.Abs(result.LUFS-n.target) > 0.01 {
		return n.fail(fmt.Errorf("process.normalize: output %.6f LUFS deviates from target %.6f LUFS", result.LUFS, n.target))
	}
	actual := result.LUFS
	n.status.OutputLUFS = &actual
	n.progress.Done = true
	n.channels, n.storage, n.block, n.verification = nil, nil, nil, nil
	return n.progress, nil
}

// Result is private and unavailable until all required phases succeed.
func (n *Normalizer) Result() (audiobuf.Document, error) {
	if n.failure != nil {
		return audiobuf.Document{}, n.failure
	}
	if !n.progress.Done {
		return audiobuf.Document{}, fmt.Errorf("process.normalize: result is not ready")
	}
	return n.result, nil
}

// MemoryDocument exposes only retained output blocks for unique-memory counting.
// Analysis contributes no new audio blocks; its bounded workspace is not a
// document sample/peak allocation and is released independently on Cancel.
func (n *Normalizer) MemoryDocument() (audiobuf.Document, error) {
	if n.failure != nil {
		return audiobuf.Document{}, n.failure
	}
	if n.builder != nil {
		return n.builder.MemoryDocument()
	}
	if n.result.Channels() > 0 {
		return n.result, nil
	}
	return audiobuf.Document{}, nil
}

func (n *Normalizer) fail(err error) (Progress, error) {
	if n.builder != nil {
		n.builder.Cancel()
	}
	n.builder = nil
	n.source, n.result = audiobuf.Document{}, audiobuf.Document{}
	n.channels, n.storage, n.block, n.analyzer, n.verification = nil, nil, nil, nil, nil
	n.failure = err
	n.progress.Done = false
	return n.progress, err
}

// Cancel terminally releases analysis, output and preview-candidate ownership.
func (n *Normalizer) Cancel() {
	if n.failure == nil {
		_, _ = n.fail(fmt.Errorf("process.normalize: %w", context.Canceled))
	}
}
