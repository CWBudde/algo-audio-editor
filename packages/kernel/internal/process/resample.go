package process

import (
	"context"
	"fmt"
	"math"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	"github.com/cwbudde/algo-dsp/dsp/resample"
)

const maxRateWorkspaceBytes int64 = 64 << 20

type rateOperation struct {
	*blockOperation
	streams       []*resample.Resampler
	input, output []float64
	inputFrames   int
	read, flush   int64
	skip          int
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
	outFrames := convertedFrames(document.Frames(), document.SampleRate(), settings.SampleRate)
	b := &blockOperation{source: document, selected: ops.Range{End: document.Frames(), ChannelMask: (1 << document.Channels()) - 1}, settings: settings, outputRate: settings.SampleRate, outputChannels: document.Channels(), outputFrames: outFrames, renderFrames: outFrames, progress: Progress{FramesTotal: outFrames}, status: NormalizationStatus{Phase: "processing", PhaseCount: 1, GainResolved: true}}
	if outFrames > 1<<53-1 {
		return nil, fmt.Errorf("process.resample: output exceeds JS-safe frame limit")
	}
	b.outputSelection = ops.Range{Start: scaledFrame(selected.Start, document.SampleRate(), settings.SampleRate, outFrames), End: scaledFrame(selected.End, document.SampleRate(), settings.SampleRate, outFrames), ChannelMask: selected.ChannelMask}
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
	g := rateGCD(document.SampleRate(), settings.SampleRate)
	up, down := settings.SampleRate/g, document.SampleRate()/g
	taps := resample.QualityProfile(quality).TapsPerPhase * ((down + up - 1) / up)
	inputCount := int(min(int64(audiobuf.BlockFrames), max(int64(1), int64(audiobuf.BlockFrames-1)*int64(down)/int64(up))))
	// The exact ratio and clone histories are bounded before designing filters.
	workspace := int64(taps)*int64(up)*16 + int64(up)*32 + int64(document.Channels())*int64(taps)*8 + int64(inputCount+audiobuf.BlockFrames)*8 + int64(audiobuf.BlockFrames)*12
	if workspace > maxRateWorkspaceBytes {
		return nil, fmt.Errorf("process.resample: exact ratio requires %d bytes, exceeding %d-byte workspace limit", workspace, maxRateWorkspaceBytes)
	}
	stream, err := resample.NewRational(up, down, resample.WithQuality(quality), resample.WithTapsPerPhase(taps))
	if err != nil {
		return nil, fmt.Errorf("process.resample: design filter: %w", err)
	}
	r.inputFrames = inputCount
	r.skip = int(math.Ceil(stream.GroupDelayOutput()))
	r.flush = (int64(r.skip)*int64(document.SampleRate())+int64(settings.SampleRate)-1)/int64(settings.SampleRate) + 1
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
	zeros := count == 0
	if zeros {
		count = int(min(int64(r.inputFrames), r.flush))
		if count == 0 {
			return r.fail(fmt.Errorf("process.resample: incomplete flushed tail"))
		}
	}
	n := r.streams[0].PredictOutputLen(count)
	if n > audiobuf.BlockFrames {
		return r.fail(fmt.Errorf("process.resample: output chunk exceeds bounded workspace"))
	}
	start := min(n, r.skip)
	kept := int(min(int64(n-start), r.outputFrames-r.progress.FramesDone))
	for channel, stream := range r.streams {
		if err := ctx.Err(); err != nil {
			return r.fail(fmt.Errorf("process.resample: %w", err))
		}
		if zeros {
			clear(r.input[:count])
		} else if r.channels[channel].ReadFloat64(r.input[:count], r.read) != count {
			return r.fail(fmt.Errorf("process.resample: short channel read"))
		}
		written, err := stream.ProcessInto(r.output, r.input[:count])
		if err != nil {
			return r.fail(fmt.Errorf("process.resample: render channel: %w", err))
		}
		if written != n {
			return r.fail(fmt.Errorf("process.resample: channel clocks differ"))
		}
		if kept > 0 {
			if err := r.storeConverted(channel, r.output[start:start+kept]); err != nil {
				return r.fail(err)
			}
		}
	}
	if zeros {
		r.flush -= int64(count)
	} else {
		r.read += int64(count)
	}
	r.skip -= start
	r.progress.FramesDone += int64(kept)
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
		metadata.Timeline.Markers[i].Frame = scaledFrame(metadata.Timeline.Markers[i].Frame, r.source.SampleRate(), r.outputRate, r.outputFrames)
	}
	regions := metadata.Timeline.Regions[:0]
	for _, region := range metadata.Timeline.Regions {
		region.Start, region.End = scaledFrame(region.Start, r.source.SampleRate(), r.outputRate, r.outputFrames), scaledFrame(region.End, r.source.SampleRate(), r.outputRate, r.outputFrames)
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

func convertedFrames(frames int64, inRate, outRate int) int64 {
	return (frames/int64(inRate))*int64(outRate) + (frames%int64(inRate)*int64(outRate)+int64(inRate)-1)/int64(inRate)
}

func scaledFrame(frame int64, inRate, outRate int, total int64) int64 {
	// Quotient/remainder avoids losing precision in long frame coordinates.
	return min(total, (frame/int64(inRate))*int64(outRate)+int64(math.Round(float64(frame%int64(inRate))*float64(outRate)/float64(inRate))))
}

func rateGCD(a, b int) int {
	for b != 0 {
		a, b = b, a%b
	}
	return a
}
