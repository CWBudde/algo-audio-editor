package effects

import (
	"context"
	"fmt"
	"math"
	"math/bits"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/process"
)

// Job materializes private immutable blocks and keeps one planar processor's
// state across all steps. Cancellation publishes neither partial audio nor DSP.
type Job struct {
	document audiobuf.Document
	selected ops.Range
	stream   *Stream
	scratch  [][]float64
	blocks   [][]*audiobuf.Block
	progress process.Progress
	result   audiobuf.Document
	failure  error
	peak     float64
	identity bool
}

// NewJob prepares bounded offline processing of a document selection.
func NewJob(document audiobuf.Document, selected ops.Range, config Config, limits process.Limits) (*Job, error) {
	if document.Channels() < 1 || document.Channels() > 8 || selected.Start < 0 || selected.End <= selected.Start || selected.End > document.Frames() || selected.ChannelMask <= 0 || selected.ChannelMask&((1<<document.Channels())-1) != selected.ChannelMask {
		return nil, fmt.Errorf("effects.job: valid nonempty document selection required")
	}
	budget := limits.MaxOutputBytes
	if budget == 0 {
		budget = process.DefaultMaxOutputBytes
	}
	if budget < 0 || budget > process.DefaultMaxOutputBytes {
		return nil, fmt.Errorf("effects.job: invalid output budget")
	}
	if selected.End-selected.Start > budget/4/int64(bits.OnesCount(uint(selected.ChannelMask))) {
		return nil, fmt.Errorf("effects.job: selected output exceeds %d-byte budget", budget)
	}
	stream, err := NewStream(document, selected, config)
	if err != nil {
		return nil, err
	}
	j := &Job{document: document, selected: selected, stream: stream, progress: process.Progress{FramesTotal: selected.End - selected.Start}, identity: stream.Identity(), scratch: make([][]float64, document.Channels()), blocks: make([][]*audiobuf.Block, document.Channels())}
	capacity := int((j.progress.FramesTotal + 32*Quantum - 1) / (32 * Quantum))
	for channel := range j.scratch {
		j.scratch[channel] = make([]float64, audiobuf.BlockFrames)
		if selected.ChannelMask&(1<<channel) != 0 {
			j.blocks[channel] = make([]*audiobuf.Block, 0, capacity)
		}
	}
	return j, nil
}

// Progress returns the current processing counters.
func (j *Job) Progress() process.Progress { return j.progress }

// Step processes one bounded batch, checking cancellation before publication.
func (j *Job) Step(ctx context.Context) (process.Progress, error) {
	if j.failure != nil {
		return j.progress, j.failure
	}
	if j.progress.Done {
		return j.progress, nil
	}
	if ctx == nil {
		return j.fail(fmt.Errorf("effects.step: nil context"))
	}
	if err := ctx.Err(); err != nil {
		return j.fail(err)
	}
	// Each step processes at most 32 fixed quanta, including expensive FFT/IR
	// effects, then yields the worker event loop for updates and cancellation.
	count := int(min(int64(32*Quantum), j.progress.FramesTotal-j.progress.FramesDone))
	for channel := range j.scratch {
		j.scratch[channel] = j.scratch[channel][:count]
	}
	if err := j.stream.Read(j.scratch, j.selected.Start+j.progress.FramesDone); err != nil {
		return j.fail(err)
	}
	if err := ctx.Err(); err != nil {
		return j.fail(err)
	}
	var staged [8]*audiobuf.Block
	for channel := range j.scratch {
		if j.selected.ChannelMask&(1<<channel) == 0 {
			continue
		}
		block, err := audiobuf.NewBlockFromFloat64(j.scratch[channel])
		if err != nil {
			return j.fail(err)
		}
		peak, err := block.FinitePeak(0, count)
		if err != nil {
			return j.fail(err)
		}
		j.peak = math.Max(j.peak, peak)
		staged[channel] = block
	}
	if err := ctx.Err(); err != nil {
		return j.fail(err)
	}
	for channel, block := range staged[:len(j.scratch)] {
		if block != nil && !j.identity {
			j.blocks[channel] = append(j.blocks[channel], block)
		}
	}
	j.progress.FramesDone += int64(count)
	if j.progress.FramesDone == j.progress.FramesTotal {
		result, err := j.assemble()
		if err != nil {
			return j.fail(err)
		}
		j.result = result
		j.progress.Done = true
		j.document = audiobuf.Document{}
		j.release()
	}
	return j.progress, nil
}

func (j *Job) assemble() (audiobuf.Document, error) {
	if j.identity {
		return j.document, nil
	}
	channels := make([]audiobuf.Channel, j.document.Channels())
	for channel := range channels {
		source, err := j.document.Channel(channel)
		if err != nil {
			return audiobuf.Document{}, err
		}
		channels[channel] = source
		if j.selected.ChannelMask&(1<<channel) == 0 {
			continue
		}
		left, err := source.Slice(0, j.selected.Start)
		if err != nil {
			return audiobuf.Document{}, err
		}
		middle, err := audiobuf.NewChannelFromBlocks(j.blocks[channel])
		if err != nil {
			return audiobuf.Document{}, err
		}
		right, err := source.Slice(j.selected.End, source.Frames())
		if err != nil {
			return audiobuf.Document{}, err
		}
		channels[channel] = left.Concat(middle).Concat(right)
	}
	return audiobuf.NewDocument(channels, j.document.SampleRate(), j.document.Metadata())
}
func (j *Job) release() { j.stream = nil; j.scratch = nil; j.blocks = nil }
func (j *Job) fail(err error) (process.Progress, error) {
	j.failure = fmt.Errorf("effects.job: %w", err)
	j.result = audiobuf.Document{}
	j.document = audiobuf.Document{}
	j.progress.Done = false
	j.release()
	return j.progress, j.failure
}

// Cancel discards private processing state and prevents publication.
func (j *Job) Cancel() {
	if j.failure == nil {
		_, _ = j.fail(context.Canceled)
	}
}

// Identity reports whether processing preserves the source audio.
func (j *Job) Identity() bool { return j.identity }

// MaterializedBytes returns the candidate sample storage estimate.
func (j *Job) MaterializedBytes() int64 {
	if j.identity {
		return 0
	}
	return (j.selected.End - j.selected.Start) * 4 * int64(bits.OnesCount(uint(j.selected.ChannelMask)))
}

// Peak returns the finite candidate peak and a false nonfinite flag; invalid samples fail processing.
func (j *Job) Peak() (float64, bool) { return j.peak, false }

// Result returns the completed immutable candidate or a processing error.
func (j *Job) Result() (audiobuf.Document, error) {
	if j.failure != nil {
		return audiobuf.Document{}, j.failure
	}
	if !j.progress.Done {
		return audiobuf.Document{}, fmt.Errorf("effects.result: incomplete")
	}
	return j.result, nil
}

// MemoryDocument exposes private candidate blocks for shared storage accounting.
func (j *Job) MemoryDocument() (audiobuf.Document, error) {
	if j.failure != nil {
		return audiobuf.Document{}, j.failure
	}
	if j.progress.Done {
		return j.result, nil
	}
	channels := make([]audiobuf.Channel, 0, len(j.blocks))
	for channel, blocks := range j.blocks {
		if j.selected.ChannelMask&(1<<channel) == 0 {
			continue
		}
		data, err := audiobuf.NewChannelFromBlocks(blocks)
		if err != nil {
			return audiobuf.Document{}, err
		}
		channels = append(channels, data)
	}
	return audiobuf.NewDocument(channels, j.document.SampleRate(), audiobuf.Metadata{})
}
