package process

import (
	"context"
	"fmt"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
	"github.com/cwbudde/algo-dsp/dsp/resample"
)

const maxRateWorkspaceBytes int64 = 64 << 20

type rateOperation struct {
	*blockOperation
	streams       []*resample.Stream
	input, output []float64
	inputFrames   int
	read          int64
}

func newRateOperation(document audiobuf.Document, selected ops.Range, settings Settings, limits Limits) (*rateOperation, error) {
	if err := validateOperation(document, selected, limits); err != nil {
		return nil, fmt.Errorf("process.resample: %w", err)
	}
	if settings.SampleRate < 8000 || settings.SampleRate > 384000 {
		return nil, fmt.Errorf("process.resample: sample rate must be in [8000,384000]")
	}
	quality := resample.QualityBalanced
	switch settings.Quality {
	case "", "balanced":
	case "fast":
		quality = resample.QualityFast
	case "best":
		quality = resample.QualityBest
	default:
		return nil, fmt.Errorf("process.resample: unsupported quality")
	}
	outFrames, err := resample.FrameCount(document.Frames(), document.SampleRate(), settings.SampleRate)
	if err != nil {
		return nil, fmt.Errorf("process.resample: output duration: %w", err)
	}
	b := &blockOperation{source: document, selected: ops.Range{End: document.Frames(), ChannelMask: (1 << document.Channels()) - 1}, settings: settings, outputRate: settings.SampleRate, outputChannels: document.Channels(), outputFrames: outFrames, renderFrames: outFrames, progress: Progress{FramesTotal: outFrames}, status: NormalizationStatus{Phase: protocol.PhaseProcessing, PhaseCount: 1, GainResolved: true}}
	if outFrames > 1<<53-1 {
		return nil, fmt.Errorf("process.resample: output exceeds JS-safe frame limit")
	}
	start, err := scaledFrame(selected.Start, document.SampleRate(), settings.SampleRate, outFrames)
	if err != nil {
		return nil, fmt.Errorf("process.resample: selection start: %w", err)
	}
	end, err := scaledFrame(selected.End, document.SampleRate(), settings.SampleRate, outFrames)
	if err != nil {
		return nil, fmt.Errorf("process.resample: selection end: %w", err)
	}
	b.outputSelection = ops.Range{Start: start, End: end, ChannelMask: selected.ChannelMask}
	r := &rateOperation{blockOperation: b}
	if document.SampleRate() == settings.SampleRate {
		b.identity, b.shared = true, true
		b.mono, b.dsp = make([]float32, audiobuf.BlockFrames), make([]float64, audiobuf.BlockFrames)
		for channel := range document.Channels() {
			part, _ := document.Channel(channel)
			b.channels = append(b.channels, part)
		}
		return r, nil
	}
	if err := outputBudget(outFrames, document.Channels(), limits); err != nil {
		return nil, fmt.Errorf("process.resample: %w", err)
	}
	plan, err := resample.NewStreamPlan(document.SampleRate(), settings.SampleRate, audiobuf.BlockFrames, quality)
	if err != nil {
		return nil, fmt.Errorf("process.resample: plan filter: %w", err)
	}
	inputCount, err := plan.InputFramesForOutputLimit(audiobuf.BlockFrames)
	if err != nil {
		return nil, fmt.Errorf("process.resample: bound chunks: %w", err)
	}
	plan, err = resample.NewStreamPlan(document.SampleRate(), settings.SampleRate, inputCount, quality)
	if err != nil {
		return nil, fmt.Errorf("process.resample: plan bounded filter: %w", err)
	}
	workspace, err := plan.WorkspaceBytes(document.Channels())
	if err != nil {
		return nil, fmt.Errorf("process.resample: estimate workspace: %w", err)
	}
	workspace += int64(inputCount+audiobuf.BlockFrames)*8 + int64(audiobuf.BlockFrames)*12
	if workspace > maxRateWorkspaceBytes {
		return nil, fmt.Errorf("process.resample: exact ratio requires %d bytes, exceeding %d-byte workspace limit", workspace, maxRateWorkspaceBytes)
	}
	stream, err := plan.NewStream(document.Frames())
	if err != nil {
		return nil, fmt.Errorf("process.resample: design filter: %w", err)
	}
	r.inputFrames = inputCount
	r.input, r.output = make([]float64, inputCount), make([]float64, audiobuf.BlockFrames)
	b.mono, b.dsp = make([]float32, audiobuf.BlockFrames), make([]float64, audiobuf.BlockFrames)
	b.blocks = make([][]*audiobuf.Block, document.Channels())
	for channel := range document.Channels() {
		part, _ := document.Channel(channel)
		b.channels = append(b.channels, part)
		if channel == 0 {
			r.streams = append(r.streams, stream)
		} else {
			r.streams = append(r.streams, stream.Clone())
		}
		b.blocks[channel] = make([]*audiobuf.Block, 0, int((outFrames+audiobuf.BlockFrames-1)/audiobuf.BlockFrames))
	}
	return r, nil
}

func (r *rateOperation) Step(ctx context.Context) (Progress, error) {
	if r.failure != nil {
		return r.progress, r.failure
	}
	if r.progress.Done {
		return r.progress, nil
	}
	if ctx == nil {
		return r.fail(fmt.Errorf("process.resample: nil context"))
	}
	if err := ctx.Err(); err != nil {
		return r.fail(fmt.Errorf("process.resample: %w", err))
	}
	if r.identity {
		count := int(min(int64(audiobuf.BlockFrames), r.outputFrames-r.progress.FramesDone))
		for channel, part := range r.channels {
			if err := ctx.Err(); err != nil {
				return r.fail(fmt.Errorf("process.resample: %w", err))
			}
			if count > 0 {
				cached, err := r.scanShared(channel, count)
				if err != nil {
					return r.fail(err)
				}
				if cached {
					continue
				}
				if part.Read(r.mono[:count], r.progress.FramesDone) != count {
					return r.fail(fmt.Errorf("process.resample: short identity read"))
				}
				if err := r.store(channel, count); err != nil {
					return r.fail(err)
				}
			}
		}
		r.progress.FramesDone += int64(count)
		if r.progress.FramesDone == r.outputFrames {
			r.result, r.progress.Done = r.source, true
			r.release()
		}
		return r.progress, nil
	}
	if r.outputFrames == 0 {
		return r.finish(ctx)
	}
	count := int(min(int64(r.inputFrames), r.source.Frames()-r.read))
	flushing := count == 0
	n := 0
	done := false
	for channel, stream := range r.streams {
		if err := ctx.Err(); err != nil {
			return r.fail(fmt.Errorf("process.resample: %w", err))
		}
		if stream.InputFrames() != r.read {
			return r.fail(fmt.Errorf("process.resample: channel clocks differ"))
		}
		if !flushing && r.channels[channel].ReadFloat64(r.input[:count], r.read) != count {
			return r.fail(fmt.Errorf("process.resample: short channel read"))
		}
		var written int
		var finished bool
		var err error
		if flushing {
			written, finished, err = stream.FlushInto(r.output)
		} else {
			written, err = stream.ProcessInto(r.output, r.input[:count])
		}
		if err != nil {
			return r.fail(fmt.Errorf("process.resample: render channel: %w", err))
		}
		if channel > 0 && (written != n || finished != done) {
			return r.fail(fmt.Errorf("process.resample: channel clocks differ"))
		}
		n, done = written, finished
		if n > 0 {
			if err := r.storeConverted(channel, r.output[:n]); err != nil {
				return r.fail(err)
			}
		}
	}
	if !flushing {
		r.read += int64(count)
	}
	r.progress.FramesDone += int64(n)
	if done && r.progress.FramesDone != r.outputFrames {
		return r.fail(fmt.Errorf("process.resample: incomplete flushed tail"))
	}
	if err := ctx.Err(); err != nil {
		return r.fail(fmt.Errorf("process.resample: %w", err))
	}
	if r.progress.FramesDone == r.outputFrames {
		return r.finish(ctx)
	}
	return r.progress, nil
}

func (r *rateOperation) finish(ctx context.Context) (Progress, error) {
	channels := make([]audiobuf.Channel, r.outputChannels)
	for i := range channels {
		var err error
		channels[i], err = audiobuf.NewChannelFromBlocks(r.blocks[i])
		if err != nil {
			return r.fail(fmt.Errorf("process.resample: assemble: %w", err))
		}
	}
	metadata := r.source.Metadata()
	for i := range metadata.Timeline.Markers {
		frame, err := scaledFrame(metadata.Timeline.Markers[i].Frame, r.source.SampleRate(), r.outputRate, r.outputFrames)
		if err != nil {
			return r.fail(fmt.Errorf("process.resample: marker position: %w", err))
		}
		metadata.Timeline.Markers[i].Frame = frame
	}
	regions := metadata.Timeline.Regions[:0]
	for _, region := range metadata.Timeline.Regions {
		var err error
		region.Start, err = scaledFrame(region.Start, r.source.SampleRate(), r.outputRate, r.outputFrames)
		if err != nil {
			return r.fail(fmt.Errorf("process.resample: region start: %w", err))
		}
		region.End, err = scaledFrame(region.End, r.source.SampleRate(), r.outputRate, r.outputFrames)
		if err != nil {
			return r.fail(fmt.Errorf("process.resample: region end: %w", err))
		}
		if region.Start < region.End {
			regions = append(regions, region)
		}
	}
	metadata.Timeline.Regions = regions
	result, err := audiobuf.NewDocument(channels, r.outputRate, metadata)
	if err != nil {
		return r.fail(fmt.Errorf("process.resample: result: %w", err))
	}
	if err := ctx.Err(); err != nil {
		return r.fail(fmt.Errorf("process.resample: %w", err))
	}
	r.result, r.progress.Done = result, true
	r.release()
	return r.progress, nil
}

func (r *rateOperation) release() {
	r.blockOperation.release()
	r.streams, r.input, r.output = nil, nil, nil
}

func (r *rateOperation) fail(err error) (Progress, error) {
	r.release()
	return r.blockOperation.fail(err)
}

func (r *rateOperation) Cancel() {
	if r.failure == nil {
		_, _ = r.fail(fmt.Errorf("process.cancel: %w", context.Canceled))
	}
}

func scaledFrame(frame int64, inRate, outRate int, total int64) (int64, error) {
	position, err := resample.FramePosition(frame, inRate, outRate)
	if err != nil {
		return 0, err
	}
	return min(total, position), nil
}
