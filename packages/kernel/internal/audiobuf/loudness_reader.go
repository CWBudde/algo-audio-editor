package audiobuf

import (
	"errors"
	"fmt"
	"math"

	"github.com/cwbudde/algo-dsp/measure/loudness"
)

// TargetFeedBuffer owns reusable, bounded planar view descriptors, not samples.
// Its zero value is ready for use by one owner. It deliberately accepts only the
// concrete tagged TargetAnalyzer, whose planar processing methods neither mutate
// nor retain input. Views never escape to callers, arbitrary callbacks, or
// processor interfaces, and are cleared after every call, including errors.
// Changes to that upstream ownership contract require reviewing this adapter.
type TargetFeedBuffer struct{ views [8][]float32 }

// FeedBlocks measures newly stored immutable output without exposing its views.
// Every channel is staged before this call; the concrete analyzer cannot retain
// or mutate samples. This measures rounded storage, never DSP scratch.
func (b *TargetFeedBuffer) FeedBlocks(analyzer *loudness.TargetAnalyzer, blocks []*Block) error {
	if b == nil {
		return fmt.Errorf("audiobuf.feedLoudness: descriptor buffer is required")
	}
	clear(b.views[:])
	defer func() { clear(b.views[:]) }()
	if analyzer == nil || len(blocks) < 1 || len(blocks) > 8 {
		return fmt.Errorf("audiobuf.feedLoudness: analyzer and 1-8 blocks required")
	}
	frames := 0
	peak, certified := 0.0, true
	for index, block := range blocks {
		if block == nil || block.Frames() < 1 || (index > 0 && block.Frames() != frames) {
			return fmt.Errorf("audiobuf.feedLoudness: equal nonempty blocks required")
		}
		frames = block.Frames()
		b.views[index] = block.samples[:frames:frames]
		measured, err := block.FinitePeak(0, frames)
		if errors.Is(err, ErrNonFiniteSamples) {
			certified = false
		} else if err != nil {
			return fmt.Errorf("audiobuf.feedLoudness: prove stored block: %w", err)
		} else {
			peak = math.Max(peak, measured)
		}
	}
	if err := b.process(analyzer, len(blocks), peak, certified); err != nil {
		return fmt.Errorf("audiobuf.feedLoudness: measure stored blocks: %w", err)
	}
	return nil
}

// Feed feeds an exact packed-channel range directly from immutable
// blocks only when every channel's range is contiguous inside one block. It
// returns false, nil for a block-spanning range, without changing analyzer state.
// All geometry is validated before feeding; invalid arguments return an error.
//
// The buffer retains no source views between calls. Reuse avoids allocating view
// descriptors per block; samples are never copied on this contiguous path.
func (b *TargetFeedBuffer) Feed(analyzer *loudness.TargetAnalyzer, channels []Channel, start int64, frames int) (bool, error) {
	if b == nil {
		return false, fmt.Errorf("audiobuf.feedLoudness: descriptor buffer is required")
	}
	clear(b.views[:])
	defer func() { clear(b.views[:]) }()
	if analyzer == nil || len(channels) < 1 || len(channels) > 8 || frames < 1 || frames > BlockFrames || start < 0 {
		return false, fmt.Errorf("audiobuf.feedLoudness: analyzer, 1-8 channels and 1-%d nonnegative-start frames required", BlockFrames)
	}
	var blockIndices, localOffsets [8]int
	contiguous := true
	for index, channel := range channels {
		// Subtraction avoids overflowing start+frames, including on WASM32.
		if start > channel.Frames() || int64(frames) > channel.Frames()-start {
			return false, fmt.Errorf("audiobuf.feedLoudness: channel %d range outside %d frames", index, channel.Frames())
		}
		blockIndex := channel.blockAt(start)
		block := channel.blocks[blockIndex]
		local := int(start - channel.offsets[blockIndex])
		if frames > block.Frames()-local {
			contiguous = false
			continue
		}
		blockIndices[index], localOffsets[index] = blockIndex, local
	}
	if !contiguous {
		return false, nil
	}
	// Fill views only after every packed channel's geometry is eligible.
	peak, certified := 0.0, true
	for index, channel := range channels {
		local := localOffsets[index]
		b.views[index] = channel.blocks[blockIndices[index]].samples[local : local+frames : local+frames]
		measured, err := channel.FinitePeak(start, start+int64(frames))
		if errors.Is(err, ErrNonFiniteSamples) {
			certified = false
		} else if err != nil {
			return false, fmt.Errorf("audiobuf.feedLoudness: prove immutable range: %w", err)
		} else {
			peak = math.Max(peak, measured)
		}
	}
	if err := b.process(analyzer, len(channels), peak, certified); err != nil {
		return false, fmt.Errorf("audiobuf.feedLoudness: analyze immutable views: %w", err)
	}
	return true, nil
}

// process replaces only upstream's redundant finite/peak preflight with an
// exact immutable-storage proof covering every supplied channel, including
// zero-weight channels. Actual K filters, windows and gates still run on every
// sample. Unsafe input uses ordinary atomic preflight and preserves its errors.
func (b *TargetFeedBuffer) process(analyzer *loudness.TargetAnalyzer, channels int, peak float64, certified bool) error {
	if certified {
		return analyzer.ProcessCertifiedPlanar32(b.views[:channels], peak)
	}
	return analyzer.ProcessPlanar32(b.views[:channels])
}
