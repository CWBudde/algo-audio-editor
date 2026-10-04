package engine

import (
	"fmt"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/memory"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	"github.com/cwbudde/algo-dsp/dsp/resample"
	vecmath "github.com/cwbudde/algo-vecmath"
)

// Converted sample storage is newly materialized, unlike shared same-format
// pastes. Refuse excessive output before allocating any filter or sample blocks.
const maxConvertedSampleBytes int64 = memory.StorageLimit

func clipboardOutputFrames(frames int64, inRate, outRate int) (int64, error) {
	if frames <= 0 || frames > maxEditorFrame || inRate < MinSampleRate || inRate > MaxSampleRate || outRate < MinSampleRate || outRate > MaxSampleRate {
		return 0, fmt.Errorf("clipboard.convert: invalid duration or sample rates")
	}
	count, err := resample.FrameCount(frames, inRate, outRate)
	if err != nil {
		return 0, fmt.Errorf("clipboard.convert: output duration: %w", err)
	}
	if count > maxEditorFrame {
		return 0, fmt.Errorf("clipboard.convert: output duration exceeds JS-safe frame limit")
	}
	return count, nil
}

// convertClipboard orchestrates tagged sinc and vecmath primitives over bounded
// planar blocks. The original clipboard remains immutable and retained. Channel
// routing is cyclic: expand by duplication, reduce by equal-weight folded sums.
func convertClipboard(clip ops.Clipboard, outRate, outChannels int) (ops.Clipboard, error) {
	if outChannels < 1 || outChannels > MaxChannels || clip.Channels() < 1 || clip.Channels() > MaxChannels {
		return ops.Clipboard{}, fmt.Errorf("clipboard.convert: invalid channel layout")
	}
	frames, err := clipboardOutputFrames(clip.Frames(), clip.SampleRate(), outRate)
	if err != nil {
		return ops.Clipboard{}, err
	}
	if clip.SampleRate() == outRate && clip.Channels() == outChannels {
		return clip, nil
	}
	if frames > maxConvertedSampleBytes/(int64(outChannels)*4) {
		return ops.Clipboard{}, fmt.Errorf("clipboard.convert: %d output frames/%d channels exceed the %d-byte materialized sample budget", frames, outChannels, maxConvertedSampleBytes)
	}
	inRate, sourceChannels := clip.SampleRate(), clip.Channels()
	capacity := transportBlockFrames
	var stream *documentResampler
	if inRate != outRate {
		plan, planErr := resample.NewStreamPlan(inRate, outRate, transportBlockFrames, resample.QualityBalanced)
		if planErr != nil {
			return ops.Clipboard{}, fmt.Errorf("clipboard.convert: plan sinc: %w", planErr)
		}
		capacity = plan.OutputBlockFrames()
		workspace, planErr := plan.WorkspaceBytes(sourceChannels)
		if planErr != nil {
			return ops.Clipboard{}, fmt.Errorf("clipboard.convert: estimate workspace: %w", planErr)
		}
		sourceBytes := int64(sourceChannels) * int64(transportBlockFrames+capacity) * 8
		sinkBytes := int64(outChannels) * (int64(capacity)*8 + int64(audiobuf.BlockFrames)*4)
		workspace += sourceBytes + sinkBytes
		if workspace > maxResampleWorkspaceBytes {
			return ops.Clipboard{}, fmt.Errorf("clipboard.convert: exact ratio needs %d bytes, exceeding the %d-byte workspace limit", workspace, maxResampleWorkspaceBytes)
		}
		stream, err = newDocumentResampler(&documentTransport{channels: make([]audiobuf.Channel, sourceChannels), end: clip.Frames()}, inRate, outRate)
		if err != nil {
			return ops.Clipboard{}, fmt.Errorf("clipboard.convert: prepare sinc: %w", err)
		}
	}
	input, output := make([][]float64, sourceChannels), make([][]float64, sourceChannels)
	for channel := range input {
		if stream != nil {
			input[channel], output[channel] = stream.input[channel], stream.output[channel]
		} else {
			input[channel] = make([]float64, transportBlockFrames)
			output[channel] = input[channel]
		}
	}
	mono := make([]float32, transportBlockFrames)
	mixed, pending := make([][]float64, outChannels), make([][]float32, outChannels)
	blocks := make([][]*audiobuf.Block, outChannels)
	for channel := range mixed {
		mixed[channel] = make([]float64, capacity)
		pending[channel] = make([]float32, audiobuf.BlockFrames)
	}
	read, written, pendingCount := int64(0), int64(0), 0
	for written < frames {
		count := int(min(int64(transportBlockFrames), clip.Frames()-read))
		flushing := count == 0
		if flushing {
			if stream == nil {
				return ops.Clipboard{}, fmt.Errorf("clipboard.convert: incomplete flushed tail")
			}
		}
		n := count
		done := false
		for channel := range input {
			if !flushing {
				if got := clip.Read(mono[:count], channel, read); got != count {
					return ops.Clipboard{}, fmt.Errorf("clipboard.convert: short channel %d read", channel)
				}
				for frame, sample := range mono[:count] {
					input[channel][frame] = float64(sample)
				}
			}
			if stream != nil {
				var got int
				var finished bool
				var processErr error
				if flushing {
					got, finished, processErr = stream.streams[channel].FlushInto(output[channel])
				} else {
					got, processErr = stream.streams[channel].ProcessInto(output[channel], input[channel][:count])
				}
				if processErr != nil {
					return ops.Clipboard{}, fmt.Errorf("clipboard.convert: sinc channel %d: %w", channel, processErr)
				}
				if channel > 0 && (got != n || finished != done) {
					return ops.Clipboard{}, fmt.Errorf("clipboard.convert: channel clocks differ")
				}
				n, done = got, finished
			}
		}
		if !flushing {
			read += int64(count)
		}
		if done && written+int64(n) != frames {
			return ops.Clipboard{}, fmt.Errorf("clipboard.convert: incomplete flushed tail")
		}
		if n == 0 {
			continue
		}
		for target := range mixed {
			stage := mixed[target][:n]
			if outChannels >= sourceChannels {
				copy(stage, output[target%sourceChannels][:n])
			} else {
				copy(stage, output[target][:n])
				contributors := 1
				for source := target + outChannels; source < sourceChannels; source += outChannels {
					vecmath.AddBlockInPlace(stage, output[source][:n])
					contributors++
				}
				if contributors > 1 {
					vecmath.ScaleBlockInPlace(stage, 1/float64(contributors))
				}
			}
		}
		for offset := 0; offset < n; {
			chunk := min(n-offset, audiobuf.BlockFrames-pendingCount)
			for channel := range pending {
				for frame, value := range mixed[channel][offset : offset+chunk] {
					pending[channel][pendingCount+frame] = float32(value)
				}
			}
			pendingCount += chunk
			offset += chunk
			if pendingCount == audiobuf.BlockFrames {
				for channel := range pending {
					block, blockErr := audiobuf.NewBlock(pending[channel])
					if blockErr != nil {
						return ops.Clipboard{}, blockErr
					}
					blocks[channel] = append(blocks[channel], block)
				}
				pendingCount = 0
			}
		}
		written += int64(n)
	}
	channels := make([]audiobuf.Channel, outChannels)
	for channel := range channels {
		if pendingCount != 0 {
			block, blockErr := audiobuf.NewBlock(pending[channel][:pendingCount])
			if blockErr != nil {
				return ops.Clipboard{}, blockErr
			}
			blocks[channel] = append(blocks[channel], block)
		}
		channels[channel], err = audiobuf.NewChannelFromBlocks(blocks[channel])
		if err != nil {
			return ops.Clipboard{}, fmt.Errorf("clipboard.convert: store channel: %w", err)
		}
	}
	document, err := audiobuf.NewDocument(channels, outRate, audiobuf.Metadata{Name: "Clipboard"})
	if err != nil {
		return ops.Clipboard{}, err
	}
	return ops.NewClipboard(document, ops.Range{End: frames, ChannelMask: (1 << outChannels) - 1})
}
