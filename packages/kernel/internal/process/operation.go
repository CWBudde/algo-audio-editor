package process

import (
	"context"
	"errors"
	"fmt"
	"math"
	"slices"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
	"github.com/cwbudde/algo-dsp/dsp/core"
	"github.com/cwbudde/algo-dsp/dsp/fade"
	"github.com/cwbudde/algo-dsp/dsp/signal"
	timestats "github.com/cwbudde/algo-dsp/stats/time"
)

// Settings contains control values only; samples remain private to a job.
type Settings struct {
	Operation                        protocol.OperationName
	GainDB, TargetDB                 float64
	Curve                            string
	DurationFrames                   int64
	ChannelMode                      string
	Channel                          int
	SampleRate                       int
	Quality, Generator               string
	Frequency, EndFrequency, LevelDB float64
	Seed                             uint64
	Restoration                      RestorationSettings
}

// NewOperation prepares a private result without reading or rendering a full
// document. Structural transforms advertise their new format before stepping.
func NewOperation(document audiobuf.Document, selected ops.Range, settings Settings, limits Limits) (Stepper, error) {
	switch settings.Operation {
	case protocol.OperationGain:
		return NewBuilder(document, selected, Gain{DB: settings.GainDB}, limits)
	case protocol.OperationNormalizePeak, protocol.OperationNormalizeLoudness:
		return NewNormalizer(document, selected, settings.Operation, settings.TargetDB, limits)
	case protocol.OperationSpectralAttenuate, protocol.OperationSpectralRemove, protocol.OperationSpectralHeal, protocol.OperationNoiseReduce, protocol.OperationRemoveClicks, protocol.OperationDeclip, protocol.OperationTimeStretch, protocol.OperationRemoveHum:
		return newRestorationOperation(document, selected, settings, limits)
	case protocol.OperationResample:
		return newRateOperation(document, selected, settings, limits)
	default:
		return newBlockOperation(document, selected, settings, limits)
	}
}

// blockOperation moves representations and coordinates tagged DSP primitives.
// One Step handles at most one storage block across at most eight channels.
type blockOperation struct {
	source                      audiobuf.Document
	selected, outputSelection   ops.Range
	settings                    Settings
	outputRate, outputChannels  int
	outputFrames, renderFrames  int64
	indices                     []int
	channels                    []audiobuf.Channel
	blocks                      [][]*audiobuf.Block
	means                       []signal.MeanAccumulator
	generators                  []*signal.StreamGenerator
	mono, second                []float32
	dsp, other, rising          []float64
	progress                    Progress
	status                      NormalizationStatus
	result                      audiobuf.Document
	peak                        float64
	nonfinite, shared, identity bool
	sharedGenerator             bool
	failure                     error
}

func validateOperation(document audiobuf.Document, selected ops.Range, limits Limits) error {
	if document.Channels() < 1 || document.Channels() > 8 || document.SampleRate() < 8000 || document.SampleRate() > 384000 || document.Frames() > 1<<53-1 {
		return fmt.Errorf("valid document format required")
	}
	if selected.Start < 0 || selected.End < selected.Start || selected.End > document.Frames() || selected.ChannelMask <= 0 || selected.ChannelMask&((1<<document.Channels())-1) != selected.ChannelMask {
		return fmt.Errorf("invalid selection")
	}
	if limits.MaxOutputBytes < 0 || limits.MaxOutputBytes > DefaultMaxOutputBytes {
		return fmt.Errorf("invalid output budget")
	}
	return nil
}

func outputBudget(frames int64, channels int, limits Limits) error {
	budget := limits.MaxOutputBytes
	if budget == 0 {
		budget = DefaultMaxOutputBytes
	}
	if frames < 0 || frames > 1<<53-1 || channels < 1 || frames > budget/4/int64(channels) {
		return fmt.Errorf("materialized output exceeds the %d-byte budget", budget)
	}
	return nil
}

func newBlockOperation(document audiobuf.Document, selected ops.Range, settings Settings, limits Limits) (*blockOperation, error) {
	if err := validateOperation(document, selected, limits); err != nil {
		return nil, fmt.Errorf("process.new: %w", err)
	}
	b := &blockOperation{source: document, selected: selected, outputSelection: selected, settings: settings, outputRate: document.SampleRate(), outputChannels: document.Channels(), outputFrames: document.Frames(), status: NormalizationStatus{Phase: protocol.PhaseProcessing, PhaseCount: 1, GainResolved: true}}
	switch settings.Operation {
	case protocol.OperationFadeIn, protocol.OperationFadeOut, protocol.OperationReverse, protocol.OperationInvert, protocol.OperationRemoveDC:
		if selected.Start == selected.End {
			b.selected.Start, b.selected.End = 0, document.Frames()
		}
		if b.selected.Start == b.selected.End {
			return nil, fmt.Errorf("process.new: nonempty audio required")
		}
		b.outputSelection = b.selected
		b.renderFrames = b.selected.End - b.selected.Start
		if settings.Operation == protocol.OperationFadeIn || settings.Operation == protocol.OperationFadeOut {
			if settings.Curve == "" {
				b.settings.Curve = string(fade.Linear)
			}
			if !validCurve(b.settings.Curve) {
				return nil, fmt.Errorf("process.new: unsupported fade curve")
			}
		}
		if settings.Operation == protocol.OperationRemoveDC {
			b.status.Phase, b.status.PhaseCount = protocol.PhaseAnalyzing, 2
		}
	case protocol.OperationCrossfade:
		n := settings.DurationFrames
		if selected.Start != selected.End || n < 2 || n > selected.Start || n > document.Frames()-selected.Start {
			return nil, fmt.Errorf("process.new: crossfade requires a cursor with sufficient audio on both sides")
		}
		b.selected = ops.Range{Start: selected.Start - n, End: selected.Start + n, ChannelMask: (1 << document.Channels()) - 1}
		b.renderFrames, b.outputFrames = n, document.Frames()-n
		b.outputSelection = ops.Range{Start: b.selected.Start, End: b.selected.Start + n, ChannelMask: b.selected.ChannelMask}
		if settings.Curve == "" {
			b.settings.Curve = string(fade.Linear)
		}
		if !validCurve(b.settings.Curve) {
			return nil, fmt.Errorf("process.new: unsupported fade curve")
		}
	case protocol.OperationMonoToStereo:
		if document.Channels() != 1 {
			return nil, fmt.Errorf("process.new: mono document required")
		}
		b.shared = true
		b.outputChannels, b.renderFrames = 2, document.Frames()
		b.selected = ops.Range{End: document.Frames(), ChannelMask: 1}
		b.outputSelection = ops.Range{Start: selected.Start, End: selected.End, ChannelMask: 3}
	case protocol.OperationStereoToMono:
		if document.Channels() != 2 || (settings.ChannelMode != "mix" && settings.ChannelMode != "left" && settings.ChannelMode != "right") {
			return nil, fmt.Errorf("process.new: stereo document and mix/left/right mode required")
		}
		b.outputChannels, b.renderFrames = 1, document.Frames()
		b.selected = ops.Range{End: document.Frames(), ChannelMask: 3}
		b.outputSelection = ops.Range{Start: selected.Start, End: selected.End, ChannelMask: 1}
		b.shared = settings.ChannelMode != "mix"
	case protocol.OperationExtractChannel:
		if settings.Channel < 0 || settings.Channel >= document.Channels() {
			return nil, fmt.Errorf("process.new: invalid extraction channel")
		}
		if selected.Start == selected.End {
			b.selected.Start, b.selected.End = 0, document.Frames()
		}
		b.selected.ChannelMask = 1 << settings.Channel
		b.renderFrames, b.outputFrames, b.outputChannels, b.shared = b.selected.End-b.selected.Start, b.selected.End-b.selected.Start, 1, true
		b.outputSelection = ops.Range{End: b.outputFrames, ChannelMask: 1}
	case protocol.OperationGenerate:
		b.renderFrames = selected.End - selected.Start
		if b.renderFrames == 0 {
			b.renderFrames = settings.DurationFrames
		}
		if b.renderFrames < 1 || b.renderFrames > (1<<53-1)-document.Frames()+(selected.End-selected.Start) {
			return nil, fmt.Errorf("process.new: invalid generator duration")
		}
		b.outputFrames = document.Frames() - (selected.End - selected.Start) + b.renderFrames
		b.outputSelection = ops.Range{Start: selected.Start, End: selected.Start + b.renderFrames, ChannelMask: selected.ChannelMask}
		if math.IsNaN(settings.LevelDB) || math.IsInf(settings.LevelDB, 0) || settings.LevelDB < -120 || settings.LevelDB > 0 {
			return nil, fmt.Errorf("process.new: generator level must be in [-120,0] dBFS")
		}
	default:
		return nil, fmt.Errorf("process.new: unsupported operation %q", settings.Operation)
	}
	for channel := range document.Channels() {
		if b.selected.ChannelMask&(1<<channel) == 0 {
			continue
		}
		if settings.Operation == protocol.OperationStereoToMono && b.shared && channel != map[string]int{"left": 0, "right": 1}[settings.ChannelMode] {
			continue
		}
		part, _ := document.Channel(channel)
		b.indices = append(b.indices, channel)
		b.channels = append(b.channels, part)
	}
	count := len(b.channels)
	if settings.Operation == protocol.OperationStereoToMono {
		count = 1
	}
	if !b.shared {
		if err := outputBudget(b.renderFrames, count, limits); err != nil {
			return nil, fmt.Errorf("process.new: %w", err)
		}
		b.blocks = make([][]*audiobuf.Block, count)
		for i := range b.blocks {
			b.blocks[i] = make([]*audiobuf.Block, 0, int((b.renderFrames+audiobuf.BlockFrames-1)/audiobuf.BlockFrames))
		}
	}
	b.mono, b.second = make([]float32, audiobuf.BlockFrames), make([]float32, audiobuf.BlockFrames)
	b.dsp = make([]float64, audiobuf.BlockFrames)
	if settings.Operation == protocol.OperationFadeIn || settings.Operation == protocol.OperationFadeOut || settings.Operation == protocol.OperationCrossfade {
		b.other = make([]float64, audiobuf.BlockFrames)
	}
	if settings.Operation == protocol.OperationCrossfade {
		b.rising = make([]float64, audiobuf.BlockFrames)
	}
	if settings.Operation == protocol.OperationRemoveDC {
		b.means = make([]signal.MeanAccumulator, len(b.channels))
	}
	if settings.Operation == protocol.OperationGenerate {
		b.sharedGenerator = settings.Generator == "silence" || settings.Generator == "sine" || settings.Generator == "linear-sweep" || settings.Generator == "log-sweep"
		for _, channel := range b.indices {
			generator, err := signal.NewStreamGenerator(signal.StreamConfig{Kind: signal.StreamKind(settings.Generator), SampleRate: float64(document.SampleRate()), Amplitude: core.DBToLinear(settings.LevelDB), StartHz: settings.Frequency, EndHz: settings.EndFrequency, Frames: b.renderFrames, Seed: settings.Seed + uint64(channel)*0x9e3779b97f4a7c15})
			if err != nil {
				return nil, fmt.Errorf("process.new: generator: %w", err)
			}
			b.generators = append(b.generators, generator)
			if b.sharedGenerator {
				break
			}
		}
	}
	b.progress.FramesTotal = b.renderFrames
	return b, nil
}

func validCurve(shape string) bool {
	return shape == string(fade.Linear) || shape == string(fade.EqualPower) || shape == string(fade.Logarithmic) || shape == string(fade.SCurve)
}

func (b *blockOperation) Progress() Progress          { return b.progress }
func (b *blockOperation) Status() NormalizationStatus { return b.status }
func (b *blockOperation) OutputSelection() ops.Range  { return b.outputSelection }
func (b *blockOperation) OutputFormat() (int, int, int64) {
	return b.outputRate, b.outputChannels, b.outputFrames
}
func (b *blockOperation) Identity() bool { return b.identity }

func (b *blockOperation) MaterializedBytes() int64 {
	if b.shared || b.identity {
		return 0
	}
	return b.renderFrames * 4 * int64(len(b.blocks))
}
func (b *blockOperation) Peak() (float64, bool) { return b.peak, b.nonfinite }

func (b *blockOperation) Step(ctx context.Context) (Progress, error) {
	if b.failure != nil {
		return b.progress, b.failure
	}
	if b.progress.Done {
		return b.progress, nil
	}
	if ctx == nil {
		return b.fail(fmt.Errorf("process.step: nil context"))
	}
	if err := ctx.Err(); err != nil {
		return b.fail(fmt.Errorf("process.step: %w", err))
	}
	count := int(min(int64(audiobuf.BlockFrames), b.renderFrames-b.progress.FramesDone))
	if count > 0 {
		if b.status.Phase == protocol.PhaseAnalyzing {
			for i, channel := range b.channels {
				if err := ctx.Err(); err != nil {
					return b.fail(err)
				}
				if channel.Read(b.mono[:count], b.selected.Start+b.progress.FramesDone) != count {
					return b.fail(fmt.Errorf("process.step: short read"))
				}
				if err := b.means[i].AddFloat32(b.mono[:count]); err != nil {
					return b.fail(fmt.Errorf("process.step: measure DC: %w", err))
				}
			}
		} else {
			if err := b.prepareEnvelope(count); err != nil {
				return b.fail(fmt.Errorf("process.step: envelope: %w", err))
			}
			for i := range len(b.channels) {
				if b.settings.Operation == protocol.OperationStereoToMono && i > 0 {
					break
				}
				if err := ctx.Err(); err != nil {
					return b.fail(fmt.Errorf("process.step: %w", err))
				}
				if b.sharedGenerator && i > 0 {
					// Deterministic generators have identical global phase on all
					// selected channels. Reuse their immutable output and summaries.
					b.blocks[i] = append(b.blocks[i], b.blocks[0][len(b.blocks[0])-1])
					continue
				}
				if b.shared {
					cached, err := b.scanShared(i, count)
					if err != nil {
						return b.fail(err)
					}
					if cached {
						continue
					}
				}
				if owned, err := b.renderOwned(i, count); owned {
					if err != nil {
						return b.fail(fmt.Errorf("process.step: channel %d: %w", i, err))
					}
					continue
				}
				if err := b.render(i, count); err != nil {
					return b.fail(fmt.Errorf("process.step: channel %d: %w", i, err))
				}
				if err := b.store(i, count); err != nil {
					return b.fail(err)
				}
			}
		}
		b.progress.FramesDone += int64(count)
	}
	if err := ctx.Err(); err != nil {
		return b.fail(fmt.Errorf("process.step: %w", err))
	}
	if b.progress.FramesDone == b.renderFrames {
		if b.status.Phase == protocol.PhaseAnalyzing {
			b.status.Phase, b.status.PhaseIndex, b.progress.FramesDone = protocol.PhaseProcessing, 1, 0
		} else {
			result, err := b.assemble()
			if err != nil {
				return b.fail(fmt.Errorf("process.step: assemble: %w", err))
			}
			if err := ctx.Err(); err != nil {
				return b.fail(fmt.Errorf("process.step: %w", err))
			}
			b.result, b.progress.Done = result, true
			b.release()
		}
	}
	return b.progress, nil
}

// Shared routing retains exact source blocks. Finite immutable summaries avoid
// copying and rescanning ordinary audio; unsafe ranges retain finite-only flags.
func (b *blockOperation) scanShared(i, count int) (bool, error) {
	start := b.selected.Start + b.progress.FramesDone
	peak, err := b.channels[i].FinitePeak(start, start+int64(count))
	if err == nil {
		b.peak = math.Max(b.peak, peak)
		return true, nil
	}
	if errors.Is(err, audiobuf.ErrNonFiniteSamples) {
		return false, nil
	}
	return false, fmt.Errorf("process.step: source peak: %w", err)
}

func (b *blockOperation) render(i, count int) error {
	offset := b.progress.FramesDone
	if b.settings.Operation != protocol.OperationGenerate {
		start := b.selected.Start + offset
		if b.settings.Operation == protocol.OperationReverse {
			start = b.selected.End - offset - int64(count)
		}
		if b.channels[i].Read(b.mono[:count], start) != count {
			return fmt.Errorf("short input read")
		}
	}
	switch b.settings.Operation {
	case protocol.OperationCrossfade:
		if b.channels[i].Read(b.second[:count], b.selected.Start+b.renderFrames+offset) != count {
			return fmt.Errorf("short crossfade read")
		}
		return fade.CrossfadeEnvelopeInto32(b.mono[:count], b.mono[:count], b.second[:count], b.other[:count], b.rising[:count])
	case protocol.OperationReverse:
		slices.Reverse(b.mono[:count])
	case protocol.OperationInvert:
		return signal.ScaleInto32(b.mono[:count], b.mono[:count], -1)
	case protocol.OperationGenerate:
		return b.generators[i].GenerateInto32(b.mono[:count])
	case protocol.OperationStereoToMono:
		if b.settings.ChannelMode == "mix" {
			if b.channels[1].Read(b.second[:count], offset) != count {
				return fmt.Errorf("short right read")
			}
			return signal.AverageInto32(b.mono[:count], b.mono[:count], b.second[:count])
		}
	}
	return nil
}

func (b *blockOperation) prepareEnvelope(count int) error {
	switch b.settings.Operation {
	case protocol.OperationFadeIn, protocol.OperationFadeOut:
		return fade.EnvelopeInto64(b.other[:count], b.progress.FramesDone, b.renderFrames, fade.Shape(b.settings.Curve), b.settings.Operation == protocol.OperationFadeIn)
	case protocol.OperationCrossfade:
		if err := fade.EnvelopeInto64(b.other[:count], b.progress.FramesDone, b.renderFrames, fade.Shape(b.settings.Curve), false); err != nil {
			return err
		}
		return fade.EnvelopeInto64(b.rising[:count], b.progress.FramesDone, b.renderFrames, fade.Shape(b.settings.Curve), true)
	default:
		return nil
	}
}

func (b *blockOperation) renderOwned(i, count int) (bool, error) {
	var block *audiobuf.Block
	var err error
	switch b.settings.Operation {
	case protocol.OperationFadeIn, protocol.OperationFadeOut:
		block, err = audiobuf.NewEnvelopeFadedBlock(b.channels[i], b.selected.Start+b.progress.FramesDone, count, b.other[:count])
	case protocol.OperationRemoveDC:
		var mean float64
		mean, err = b.means[i].Mean()
		if err == nil {
			block, err = audiobuf.NewDCRemovedBlock(b.channels[i], b.selected.Start+b.progress.FramesDone, count, mean)
		}
	default:
		return false, nil
	}
	if err != nil {
		return true, err
	}
	return true, b.storeBlock(i, block)
}

func (b *blockOperation) store(i, count int) error {
	if !b.shared {
		block, err := audiobuf.NewBlock(b.mono[:count])
		if err != nil {
			return fmt.Errorf("process.step: store: %w", err)
		}
		return b.storeBlock(i, block)
	}
	b.measureStoredSamples(b.mono[:count])
	return nil
}

// storeConverted rounds an upstream float64 block straight into immutable
// storage. Only unsafe output needs conversion scratch for warning telemetry.
func (b *blockOperation) storeConverted(i int, samples []float64) error {
	block, err := audiobuf.NewBlockFromFloat64(samples)
	if err != nil {
		return fmt.Errorf("process.step: store converted: %w", err)
	}
	return b.storeBlock(i, block)
}

func (b *blockOperation) storeBlock(i int, block *audiobuf.Block) error {
	b.blocks[i] = append(b.blocks[i], block)
	peak, err := block.FinitePeak(0, block.Frames())
	if err == nil {
		b.peak = math.Max(b.peak, peak)
		return nil
	}
	if !errors.Is(err, audiobuf.ErrNonFiniteSamples) {
		return err
	}
	block.Read(b.mono[:block.Frames()], 0)
	b.measureStoredSamples(b.mono[:block.Frames()])
	return nil
}

func (b *blockOperation) measureStoredSamples(samples []float32) {
	finite := 0
	for _, sample := range samples {
		if math.Float32bits(sample)&0x7f800000 == 0x7f800000 {
			b.nonfinite = true
			continue
		}
		b.dsp[finite] = float64(sample)
		finite++
	}
	b.peak = math.Max(b.peak, timestats.Peak(b.dsp[:finite]))
}

func (b *blockOperation) assemble() (audiobuf.Document, error) {
	metadata := b.source.Metadata()
	op := b.settings.Operation
	if b.shared {
		part, err := b.channels[0].Slice(b.selected.Start, b.selected.End)
		if err != nil {
			return audiobuf.Document{}, err
		}
		if op == protocol.OperationExtractChannel {
			metadata.Timeline, err = metadata.Timeline.Crop(b.source.Frames(), b.selected.Start, b.selected.End)
			if err != nil {
				return audiobuf.Document{}, err
			}
		}
		channels := []audiobuf.Channel{part}
		if op == protocol.OperationMonoToStereo {
			channels = append(channels, part)
		}
		return audiobuf.NewDocument(channels, b.outputRate, metadata)
	}
	middles := make([]audiobuf.Channel, len(b.blocks))
	for i := range middles {
		var err error
		middles[i], err = audiobuf.NewChannelFromBlocks(b.blocks[i])
		if err != nil {
			return audiobuf.Document{}, err
		}
	}
	if op == protocol.OperationStereoToMono {
		return audiobuf.NewDocument(middles, b.outputRate, metadata)
	}
	channels := make([]audiobuf.Channel, b.source.Channels())
	packed := 0
	for i := range channels {
		channel, _ := b.source.Channel(i)
		channels[i] = channel
		if b.selected.ChannelMask&(1<<i) == 0 {
			if op == protocol.OperationGenerate && b.selected.Start == b.selected.End {
				left, err := channel.Slice(0, b.selected.Start)
				if err != nil {
					return audiobuf.Document{}, err
				}
				right, err := channel.Slice(b.selected.End, channel.Frames())
				if err != nil {
					return audiobuf.Document{}, err
				}
				silence, err := audiobuf.NewSilence(b.renderFrames)
				if err != nil {
					return audiobuf.Document{}, err
				}
				channels[i] = left.Concat(silence).Concat(right)
			}
			continue
		}
		left, err := channel.Slice(0, b.selected.Start)
		if err != nil {
			return audiobuf.Document{}, err
		}
		right, err := channel.Slice(b.selected.End, channel.Frames())
		if err != nil {
			return audiobuf.Document{}, err
		}
		channels[i] = left.Concat(middles[packed]).Concat(right)
		packed++
	}
	if op == protocol.OperationTimeStretch {
		stretchTimeline(&metadata.Timeline, b.selected, b.renderFrames)
	}
	if (op == protocol.OperationCrossfade || op == protocol.OperationGenerate) && b.selected.ChannelMask == (1<<b.source.Channels())-1 || op == protocol.OperationGenerate && b.selected.Start == b.selected.End {
		var err error
		metadata.Timeline, err = metadata.Timeline.Splice(b.source.Frames(), b.selected.Start, b.selected.End, b.renderFrames)
		if err != nil {
			return audiobuf.Document{}, err
		}
	}
	for i := range channels {
		if extra := b.outputFrames - channels[i].Frames(); extra > 0 {
			silence, err := audiobuf.NewSilence(extra)
			if err != nil {
				return audiobuf.Document{}, err
			}
			channels[i] = channels[i].Concat(silence)
		}
	}
	return audiobuf.NewDocument(channels, b.outputRate, metadata)
}

func (b *blockOperation) Result() (audiobuf.Document, error) {
	if b.failure != nil {
		return audiobuf.Document{}, b.failure
	}
	if !b.progress.Done {
		return audiobuf.Document{}, fmt.Errorf("process.result: incomplete")
	}
	return b.result, nil
}

func (b *blockOperation) MemoryDocument() (audiobuf.Document, error) {
	if b.failure != nil {
		return audiobuf.Document{}, b.failure
	}
	if b.progress.Done {
		return b.result, nil
	}
	if len(b.blocks) == 0 {
		return audiobuf.Document{}, nil
	}
	channels := make([]audiobuf.Channel, len(b.blocks))
	for i := range channels {
		var err error
		channels[i], err = audiobuf.NewChannelFromBlocks(b.blocks[i])
		if err != nil {
			return audiobuf.Document{}, err
		}
	}
	return audiobuf.NewDocument(channels, b.outputRate, audiobuf.Metadata{})
}

func (b *blockOperation) release() {
	b.source = audiobuf.Document{}
	b.channels, b.indices, b.blocks, b.means, b.generators = nil, nil, nil, nil, nil
	b.mono, b.second, b.dsp, b.other, b.rising = nil, nil, nil, nil, nil
}

func (b *blockOperation) fail(err error) (Progress, error) {
	b.failure, b.progress.Done, b.result = err, false, audiobuf.Document{}
	b.release()
	return b.progress, err
}

func (b *blockOperation) Cancel() {
	if b.failure == nil {
		_, _ = b.fail(fmt.Errorf("process.cancel: %w", context.Canceled))
	}
}
