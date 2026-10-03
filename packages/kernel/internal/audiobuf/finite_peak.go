package audiobuf

import (
	"errors"
	"fmt"
	"math"
)

// ErrNonFiniteSamples means the exact requested range contains NaN or infinity.
var ErrNonFiniteSamples = errors.New("range contains nonfinite samples")

// FinitePeak returns the exact finite sample peak of [start, end), without
// copying samples or allocating. An empty valid range returns positive zero.
// Fully contained cached buckets are reused; partial bucket boundaries are
// summarized from their exact samples, never from display buckets that extend
// outside the range. Nonfinite samples outside the range do not affect it.
func (c Channel) FinitePeak(start, end int64) (float64, error) {
	if start < 0 || end < start || end > c.Frames() {
		return 0, fmt.Errorf("channel.finitePeak: range [%d, %d) outside [0, %d)", start, end, c.Frames())
	}
	if start == end {
		return 0, nil
	}
	peak := 0.0
	for index := c.blockAt(start); index < len(c.blocks) && c.offsets[index] < end; index++ {
		block := c.blocks[index]
		lo := int(max(start, c.offsets[index]) - c.offsets[index])
		hi := int(min(end, c.offsets[index+1]) - c.offsets[index])
		blockPeak, err := block.FinitePeak(lo, hi)
		if err != nil {
			return 0, fmt.Errorf("channel.finitePeak: %w", err)
		}
		peak = math.Max(peak, blockPeak)
	}
	return peak, nil
}

// FinitePeak returns the exact finite sample peak of the block's [start, end)
// range without copying or allocating. Empty valid ranges return positive zero;
// any contained NaN or infinity returns ErrNonFiniteSamples. Samples outside
// the requested interval do not affect the result.
func (b *Block) FinitePeak(start, end int) (float64, error) {
	if b == nil {
		return 0, fmt.Errorf("block.finitePeak: block is required")
	}
	if start < 0 || end < start || end > b.Frames() {
		return 0, fmt.Errorf("block.finitePeak: range [%d, %d) outside [0, %d)", start, end, b.Frames())
	}
	peak := 0.0
	for start < end {
		summary, next := b.containedPeakSummary(start, end)
		// Float32 squares and their sum over <=65536 samples cannot
		// overflow float64. Energy therefore detects every NaN/Inf,
		// including later NaNs that leave cached extrema finite.
		if math.IsNaN(summary.energy) || math.IsInf(summary.energy, 0) {
			return 0, fmt.Errorf("block.finitePeak: %w", ErrNonFiniteSamples)
		}
		peak = math.Max(peak, math.Max(math.Abs(float64(summary.min)), math.Abs(float64(summary.max))))
		start = next
	}
	return peak, nil
}

func (b *Block) containedPeakSummary(start, end int) (peakSummary, int) {
	for level := len(peakFrames) - 1; level >= 0; level-- {
		size := int(peakFrames[level])
		if start%size != 0 {
			continue
		}
		bucketEnd := min(start+size, b.Frames())
		if bucketEnd <= end {
			return b.peaks[level][start/size], bucketEnd
		}
	}
	// Only the leading/trailing part of a finest-level bucket needs raw
	// upstream Summary. A subsequent aligned part can return to the cache.
	next := min(end, (start/int(peakFrames[0])+1)*int(peakFrames[0]))
	return calculatePeak(b.samples[start:next]), next
}
