package process

import (
	"context"
	"fmt"
	"math"
	"math/bits"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/memory"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	"github.com/cwbudde/algo-dsp/measure/loudness"
	timestats "github.com/cwbudde/algo-dsp/stats/time"
)

const DefaultMaxOutputBytes int64 = memory.StorageLimit

// Limits bounds newly materialized selected-channel float32 samples. Cached
// peaks and at most two fractional boundary copies per selected channel are
// additional; the engine reserves those against its shared storage budget.
// Zero chooses DefaultMaxOutputBytes. Limits outside [0, DefaultMaxOutputBytes]
// are invalid; callers may tighten but not bypass the materialization ceiling.
type Limits struct{ MaxOutputBytes int64 }

type Progress struct {
	FramesDone, FramesTotal int64
	Done                    bool
}

// Stepper owns one private, cancellable candidate. Engine orchestration does
// not depend on whether it is a simple processor or a multi-phase normalizer.
type Stepper interface {
	Step(context.Context) (Progress, error)
	Result() (audiobuf.Document, error)
	Cancel()
	Peak() (float64, bool)
	MemoryDocument() (audiobuf.Document, error)
	Identity() bool
	MaterializedBytes() int64
}

// MaterializedBytes bounds newly retained samples before any processing step.
func (b *Builder) MaterializedBytes() int64 {
	if b.identity {
		return 0
	}
	return (b.selected.End - b.selected.Start) * 4 * int64(bits.OnesCount(uint(b.selected.ChannelMask)))
}

// Builder is a single-owner, length-preserving job. Step/Result/Cancel must not
// run concurrently; Step's context may be cancelled from another goroutine.
// No result or partial blocks are ever published into the input document.
type Builder struct {
	document     audiobuf.Document
	selected     ops.Range
	channels     []audiobuf.Channel
	indices      []int
	processors   []Processor
	blocks       [][]*audiobuf.Block
	mono         []float32
	dsp          []float64
	progress     Progress
	result       audiobuf.Document
	failure      error
	peak         float64
	nonfinite    bool
	identity     bool
	observer     *loudness.TargetAnalyzer
	feed         audiobuf.TargetFeedBuffer
	finiteLinear bool
}

// Progress reports current bounded work without advancing the candidate.
func (b *Builder) Progress() Progress { return b.progress }

// ObserveLoudness independently meters each rounded output chunk before it is
// retained. It must be configured before stepping a nonidentity builder.
func (b *Builder) ObserveLoudness(analyzer *loudness.TargetAnalyzer) error {
	if analyzer == nil || b.identity || b.progress.FramesDone != 0 {
		return fmt.Errorf("process.observe: fresh nonidentity builder and analyzer required")
	}
	b.observer = analyzer
	return nil
}

func NewBuilder(document audiobuf.Document, selected ops.Range, process Process, limits Limits) (*Builder, error) {
	if err := validate(document, selected, process, limits); err != nil {
		return nil, fmt.Errorf("process.new: %w", err)
	}
	count := bits.OnesCount(uint(selected.ChannelMask))
	builder := &Builder{document: document, selected: selected, progress: Progress{FramesTotal: selected.End - selected.Start}, identity: identityProcess(process), channels: make([]audiobuf.Channel, count), indices: make([]int, 0, count), processors: make([]Processor, 0, count), blocks: make([][]*audiobuf.Block, count)}
	switch process.(type) {
	case LinearGain, *LinearGain:
		builder.finiteLinear = true
	}
	for channel := range document.Channels() {
		if selected.ChannelMask&(1<<channel) == 0 {
			continue
		}
		processor, err := newProcessor(process, document.SampleRate(), channel, builder.progress.FramesTotal)
		if err != nil {
			return nil, fmt.Errorf("process.new: channel %d: %w", channel, err)
		}
		if processor == nil {
			return nil, fmt.Errorf("process.new: channel %d: nil processor", channel)
		}
		builder.channels[len(builder.indices)], err = document.Channel(channel)
		if err != nil {
			return nil, fmt.Errorf("process.new: channel %d: %w", channel, err)
		}
		builder.indices = append(builder.indices, channel)
		builder.processors = append(builder.processors, processor)
	}
	if !builder.identity {
		capacity := int((builder.progress.FramesTotal + audiobuf.BlockFrames - 1) / audiobuf.BlockFrames)
		for channel := range builder.blocks {
			builder.blocks[channel] = make([]*audiobuf.Block, 0, capacity)
		}
	}
	if builder.identity {
		builder.mono = make([]float32, audiobuf.BlockFrames)
	}
	builder.dsp = make([]float64, audiobuf.BlockFrames)
	return builder, nil
}

func validate(document audiobuf.Document, selected ops.Range, process Process, limits Limits) error {
	if document.Channels() < 1 || document.Channels() > 8 || document.SampleRate() <= 0 || document.Frames() > 1<<53-1 || process == nil {
		return fmt.Errorf("valid document, channel layout and process are required")
	}
	if selected.Start < 0 || selected.End <= selected.Start || selected.End > document.Frames() {
		return fmt.Errorf("selection must be a nonempty document range")
	}
	available := (1 << document.Channels()) - 1
	if selected.ChannelMask <= 0 || selected.ChannelMask&available != selected.ChannelMask {
		return fmt.Errorf("channel mask must select a positive subset of available channels")
	}
	if limits.MaxOutputBytes < 0 || limits.MaxOutputBytes > DefaultMaxOutputBytes {
		return fmt.Errorf("materialized output budget must be in [0, %d]", DefaultMaxOutputBytes)
	}
	budget := limits.MaxOutputBytes
	if budget == 0 {
		budget = DefaultMaxOutputBytes
	}
	if !identityProcess(process) && selected.End-selected.Start > budget/4/int64(bits.OnesCount(uint(selected.ChannelMask))) {
		return fmt.Errorf("materialized selected output exceeds the %d-byte budget", budget)
	}
	return nil
}

func newProcessor(process Process, rate, channel int, frames int64) (processor Processor, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			processor = nil
			err = fmt.Errorf("processor factory panic: %v", recovered)
		}
	}()
	return process.NewChannel(rate, channel, frames)
}

func runProcessor(processor Processor, block []float64) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("processor panic: %v", recovered)
		}
	}()
	return processor.ProcessBlock(block)
}

// Step processes one <=BlockFrames chunk across every selected channel, then
// returns to its caller. A worker must yield its event loop between bounded
// batches to receive cancellation; it must not drain a job in one bridge call.
func (b *Builder) Step(ctx context.Context) (Progress, error) {
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
	count := int(min(int64(audiobuf.BlockFrames), b.progress.FramesTotal-b.progress.FramesDone))
	var staged [8]*audiobuf.Block
	peak, nonfinite := b.peak, b.nonfinite
	for channel := range b.channels {
		if err := ctx.Err(); err != nil {
			return b.fail(fmt.Errorf("process.step: %w", err))
		}
		finite := 0
		if !b.identity {
			if gain, ok := b.processors[channel].(gainProcessor); ok && b.finiteLinear {
				var err error
				staged[channel], err = audiobuf.NewScaledBlock(b.channels[channel], b.selected.Start+b.progress.FramesDone, count, gain.linear)
				if err != nil {
					return b.fail(fmt.Errorf("process.step: channel %d scale/store: %w", b.indices[channel], err))
				}
				amplitude, err := staged[channel].FinitePeak(0, count)
				if err == nil {
					peak = math.Max(peak, amplitude)
				} else {
					// Preserve Builder's unsafe-output telemetry; Normalize rejects
					// this candidate before publishing or measuring it.
					if b.mono == nil {
						b.mono = make([]float32, audiobuf.BlockFrames)
					}
					staged[channel].Read(b.mono[:count], 0)
					for _, value := range b.mono[:count] {
						if math.Float32bits(value)&0x7f800000 == 0x7f800000 {
							nonfinite = true
							continue
						}
						b.dsp[finite] = float64(value)
						finite++
					}
					peak = math.Max(peak, timestats.Peak(b.dsp[:finite]))
				}
				continue
			}
			if n := b.channels[channel].ReadFloat64(b.dsp[:count], b.selected.Start+b.progress.FramesDone); n != count {
				return b.fail(fmt.Errorf("process.step: channel %d read %d of %d frames", b.indices[channel], n, count))
			}
			if err := runProcessor(b.processors[channel], b.dsp[:count]); err != nil {
				return b.fail(fmt.Errorf("process.step: channel %d: %w", b.indices[channel], err))
			}
			// Round directly into immutable owned storage. Its already-computed
			// summaries prove finiteness and give the exact stored amplitude, so
			// ordinary output needs neither another copy nor another peak scan.
			var err error
			staged[channel], err = audiobuf.NewBlockFromFloat64(b.dsp[:count])
			if err != nil {
				return b.fail(fmt.Errorf("process.step: channel %d store: %w", b.indices[channel], err))
			}
			if amplitude, err := staged[channel].FinitePeak(0, count); err == nil {
				peak = math.Max(peak, amplitude)
				continue
			}
			// Round to the stored representation before measuring amplitude.
			// Only unsafe output needs finite-only warning telemetry. Compacting
			// scratch is safe: finite never exceeds frame, so writes
			// cannot overwrite an unread processor output. Algorithms/reductions
			// stay upstream; this loop only moves and classifies representations.
			for _, value := range b.dsp[:count] {
				rounded := float32(value)
				if math.Float32bits(rounded)&0x7f800000 == 0x7f800000 {
					nonfinite = true
					continue
				}
				b.dsp[finite] = float64(rounded)
				finite++
			}
		} else {
			// Identity never rewrites samples, including signaling NaN bits.
			if n := b.channels[channel].Read(b.mono[:count], b.selected.Start+b.progress.FramesDone); n != count {
				return b.fail(fmt.Errorf("process.step: channel %d read %d of %d frames", b.indices[channel], n, count))
			}
			for _, value := range b.mono[:count] {
				if math.Float32bits(value)&0x7f800000 == 0x7f800000 {
					nonfinite = true
					continue
				}
				b.dsp[finite] = float64(value)
				finite++
			}
		}
		// Finite reduction belongs to upstream Peak; its SIMD alternative has
		// different NaN semantics on unclassified input.
		peak = math.Max(peak, timestats.Peak(b.dsp[:finite]))
	}
	if err := ctx.Err(); err != nil {
		return b.fail(fmt.Errorf("process.step: %w", err))
	}
	if !b.identity {
		if b.observer != nil {
			if err := b.feed.FeedBlocks(b.observer, staged[:len(b.channels)]); err != nil {
				return b.fail(fmt.Errorf("process.step: measure stored output: %w", err))
			}
		}
		for channel := range b.blocks {
			b.blocks[channel] = append(b.blocks[channel], staged[channel])
		}
	}
	b.peak, b.nonfinite = peak, nonfinite
	b.progress.FramesDone += int64(count)
	if b.progress.FramesDone == b.progress.FramesTotal {
		result, err := b.buildResult()
		if err != nil {
			return b.fail(fmt.Errorf("process.step: assemble result: %w", err))
		}
		if err := ctx.Err(); err != nil {
			return b.fail(fmt.Errorf("process.step: %w", err))
		}
		b.result = result
		b.progress.Done = true
		b.document = audiobuf.Document{}
		b.release()
	}
	return b.progress, nil
}

func (b *Builder) buildResult() (audiobuf.Document, error) {
	if b.identity {
		return b.document, nil
	}
	channels := make([]audiobuf.Channel, b.document.Channels())
	packed := 0
	for i := range channels {
		channel, err := b.document.Channel(i)
		if err != nil {
			return audiobuf.Document{}, err
		}
		channels[i] = channel
		if b.selected.ChannelMask&(1<<i) == 0 {
			continue
		}
		middle, err := audiobuf.NewChannelFromBlocks(b.blocks[packed])
		if err != nil {
			return audiobuf.Document{}, err
		}
		left, err := channel.Slice(0, b.selected.Start)
		if err != nil {
			return audiobuf.Document{}, err
		}
		right, err := channel.Slice(b.selected.End, channel.Frames())
		if err != nil {
			return audiobuf.Document{}, err
		}
		channels[i] = left.Concat(middle).Concat(right)
		packed++
	}
	return audiobuf.NewDocument(channels, b.document.SampleRate(), b.document.Metadata())
}

func (b *Builder) release() {
	b.channels, b.indices, b.processors, b.blocks, b.mono, b.dsp = nil, nil, nil, nil, nil, nil
	b.observer = nil
}

func (b *Builder) fail(err error) (Progress, error) {
	b.failure = err
	b.result, b.document = audiobuf.Document{}, audiobuf.Document{}
	b.progress.Done = false
	b.release()
	return b.progress, err
}

// Cancel is idempotent and also invalidates an already-completed result. Values
// previously returned by Result remain immutable and retain their own blocks.
func (b *Builder) Cancel() {
	if b.failure == nil {
		_, _ = b.fail(fmt.Errorf("process.cancel: %w", context.Canceled))
	}
}

func (b *Builder) Result() (audiobuf.Document, error) {
	if b.failure != nil {
		return audiobuf.Document{}, b.failure
	}
	if !b.progress.Done {
		return audiobuf.Document{}, fmt.Errorf("process.result: processing is incomplete")
	}
	return b.result, nil
}

// Peak reports only finite processed float32 amplitude, with a separate flag
// for NaN/Inf. It is always safe to serialize the numeric value as JSON.
func (b *Builder) Peak() (float64, bool) { return b.peak, b.nonfinite }

// Identity reports whether this builder retains the exact original document.
func (b *Builder) Identity() bool { return b.identity }

// MemoryDocument returns the completed result, or a packed equal-length
// document containing only newly owned output so far, for dedup accounting.
// Partial accounting documents intentionally have no source timeline metadata.
func (b *Builder) MemoryDocument() (audiobuf.Document, error) {
	if b.failure != nil {
		return audiobuf.Document{}, b.failure
	}
	if b.progress.Done {
		return b.result, nil
	}
	channels := make([]audiobuf.Channel, len(b.blocks))
	for i := range channels {
		var err error
		channels[i], err = audiobuf.NewChannelFromBlocks(b.blocks[i])
		if err != nil {
			return audiobuf.Document{}, fmt.Errorf("process.memory: channel %d: %w", i, err)
		}
	}
	document, err := audiobuf.NewDocument(channels, b.document.SampleRate(), audiobuf.Metadata{})
	if err != nil {
		return audiobuf.Document{}, fmt.Errorf("process.memory: %w", err)
	}
	return document, nil
}
