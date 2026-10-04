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
	count := convertedFrameCount(frames, int64(inRate), int64(outRate))
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
		g := rateGCD(inRate, outRate)
		up, down := outRate/g, inRate/g
		taps := resample.QualityProfile(resample.QualityBalanced).TapsPerPhase * ((down + up - 1) / up)
		capacity = (transportBlockFrames*outRate+inRate-1)/inRate + 1
		coefficients := int64(taps)*int64(up)*16 + int64(up)*32
		sourceBytes := int64(sourceChannels) * int64(taps+transportBlockFrames+capacity) * 8
		sinkBytes := int64(outChannels) * (int64(capacity)*8 + int64(audiobuf.BlockFrames)*4)
		if coefficients+sourceBytes+sinkBytes > maxResampleWorkspaceBytes {
			return ops.Clipboard{}, fmt.Errorf("clipboard.convert: exact ratio needs %d bytes, exceeding the %d-byte workspace limit", coefficients+sourceBytes+sinkBytes, maxResampleWorkspaceBytes)
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
		zeros := count == 0
		if zeros {
			if stream == nil || stream.flushRemaining == 0 {
				return ops.Clipboard{}, fmt.Errorf("clipboard.convert: incomplete flushed tail")
			}
			count = int(min(int64(transportBlockFrames), stream.flushRemaining))
			stream.flushRemaining -= int64(count)
		}
		n := count
		for channel := range input {
			if zeros {
				clear(input[channel][:count])
			} else {
				if got := clip.Read(mono[:count], channel, read); got != count {
					return ops.Clipboard{}, fmt.Errorf("clipboard.convert: short channel %d read", channel)
				}
				for frame, sample := range mono[:count] {
					input[channel][frame] = float64(sample)
				}
			}
			if stream != nil {
				got, processErr := stream.streams[channel].ProcessInto(output[channel], input[channel][:count])
				if processErr != nil {
					return ops.Clipboard{}, fmt.Errorf("clipboard.convert: sinc channel %d: %w", channel, processErr)
				}
				if channel > 0 && got != n {
					return ops.Clipboard{}, fmt.Errorf("clipboard.convert: channel clocks differ")
				}
				n = got
			}
		}
		if !zeros {
			read += int64(count)
		}
		start := 0
		if stream != nil {
			start = min(n, stream.skip)
			stream.skip -= start
		}
		n = int(min(int64(n-start), frames-written))
		if n == 0 {
			continue
		}
		for target := range mixed {
			stage := mixed[target][:n]
			if outChannels >= sourceChannels {
				copy(stage, output[target%sourceChannels][start:start+n])
			} else {
				copy(stage, output[target][start:start+n])
				contributors := 1
				for source := target + outChannels; source < sourceChannels; source += outChannels {
					vecmath.AddBlockInPlace(stage, output[source][start:start+n])
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
