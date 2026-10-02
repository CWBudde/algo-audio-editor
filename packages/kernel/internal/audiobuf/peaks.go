package audiobuf

import (
	"encoding/binary"
	"fmt"
	"math"

	timestats "github.com/cwbudde/algo-dsp/stats/time"
)

const (
	maxPeakBuckets   = 8192
	maxPeakRecords   = 1 << 20
	maxSafeFrame     = 1<<53 - 1
	peakSummaryBytes = 16 // two float32 extrema and float64 sum of squares
)

var peakFrames = [3]int64{256, 4096, 65536}

type peakSummary struct {
	min, max float32
	energy   float64
}

// PeakData contains immutable-range summaries encoded for transfer to JS.
// Data stores Count interleaved float32 min/max/RMS records, followed by Count
// uint32 frame counts and Count float64 start frames (24 bytes per record).
// Cached buckets may extend outside the requested range; consumers clip them.
type PeakData struct {
	FramesPerBucket int64
	Count           int
	Data            []byte
}

func calculatePeak(samples []float32) peakSummary {
	stats := timestats.Summary(samples)

	return peakSummary{min: float32(stats.Min), max: float32(stats.Max), energy: stats.Energy}
}

func (b *Block) buildPeaks() {
	b.peaks[0] = make([]peakSummary, (b.Frames()+255)/256)
	for i := range b.peaks[0] {
		start, end := i*256, min((i+1)*256, b.Frames())
		b.peaks[0][i] = calculatePeak(b.samples[start:end])
	}
	for level := 1; level < len(peakFrames); level++ {
		size := int(peakFrames[level])
		factor := int(peakFrames[level] / peakFrames[level-1])
		b.peaks[level] = make([]peakSummary, (b.Frames()+size-1)/size)
		for i := range b.peaks[level] {
			children := b.peaks[level-1][i*factor : min((i+1)*factor, len(b.peaks[level-1]))]
			summary := children[0]
			nanExtrema := math.IsNaN(float64(summary.min)) || math.IsNaN(float64(summary.max))
			for _, child := range children[1:] {
				if child.min < summary.min {
					summary.min = child.min
				}
				if child.max > summary.max {
					summary.max = child.max
				}
				summary.energy += child.energy
				nanExtrema = nanExtrema || math.IsNaN(float64(child.min)) || math.IsNaN(float64(child.max))
			}
			if nanExtrema {
				// Summary's extrema depend on whether the first sample is NaN.
				// Recalculate affected ranges once to preserve that exact behavior.
				start, end := i*size, min((i+1)*size, b.Frames())
				summary = calculatePeak(b.samples[start:end])
			}
			b.peaks[level][i] = summary
		}
	}
}

// Peaks returns all per-block buckets intersecting [start, end). It chooses the
// coarsest cached level no wider than the requested frames per display bucket.
// Below 256 frames per bucket, it calculates raw summaries without scratch.
// Neither cached nor raw requests mutate sample or summary storage.
func (c Channel) Peaks(start, end int64, buckets int) (PeakData, error) {
	if start < 0 || end < start || end > c.Frames() || end > maxSafeFrame {
		return PeakData{}, fmt.Errorf("channel.peaks: range [%d, %d) outside a valid JS-safe channel range [0, %d)", start, end, c.Frames())
	}
	if buckets < 1 || buckets > maxPeakBuckets {
		return PeakData{}, fmt.Errorf("channel.peaks: buckets %d must be in [1, %d]", buckets, maxPeakBuckets)
	}
	if start == end {
		return PeakData{FramesPerBucket: 1, Data: []byte{}}, nil
	}

	size, level := max(int64(1), (end-start)/int64(buckets)), -1
	for i, cachedSize := range peakFrames {
		if cachedSize <= size {
			level = i
		}
	}
	if level >= 0 {
		size = peakFrames[level]
	}
	first, last := c.blockAt(start), c.blockAt(end-1)
	count := 0
	for i := first; i <= last; i++ {
		lo, hi := c.peakRange(i, start, end, size)
		if hi-lo > maxPeakRecords-int64(count) {
			return PeakData{}, fmt.Errorf("channel.peaks: output exceeds %d records", maxPeakRecords)
		}
		if c.offsets[i]+min(hi*size, int64(c.blocks[i].Frames())) > maxSafeFrame {
			return PeakData{}, fmt.Errorf("channel.peaks: bucket range exceeds JS-safe frame offsets")
		}
		count += int(hi - lo)
	}
	result := PeakData{FramesPerBucket: size, Count: count, Data: make([]byte, count*24)}
	record := 0
	for i := first; i <= last; i++ {
		block := c.blocks[i]
		lo, hi := c.peakRange(i, start, end, size)
		for bucket := lo; bucket < hi; bucket++ {
			localStart := bucket * size
			frames := min(size, int64(block.Frames())-localStart)
			var summary peakSummary
			if level >= 0 {
				summary = block.peaks[level][bucket]
			} else {
				summary = calculatePeak(block.samples[localStart : localStart+frames])
			}
			result.put(record, summary, c.offsets[i]+localStart, frames)
			record++
		}
	}

	return result, nil
}

func (c Channel) peakRange(block int, start, end, size int64) (int64, int64) {
	lo := (max(start, c.offsets[block]) - c.offsets[block]) / size
	hi := (min(end, c.offsets[block+1]) - c.offsets[block] + size - 1) / size

	return lo, hi
}

func (p PeakData) put(record int, summary peakSummary, start, frames int64) {
	binary.LittleEndian.PutUint32(p.Data[record*12:], math.Float32bits(summary.min))
	binary.LittleEndian.PutUint32(p.Data[record*12+4:], math.Float32bits(summary.max))
	rms := float32(math.Sqrt(summary.energy / float64(frames)))
	binary.LittleEndian.PutUint32(p.Data[record*12+8:], math.Float32bits(rms))
	binary.LittleEndian.PutUint32(p.Data[p.Count*12+record*4:], uint32(frames))
	binary.LittleEndian.PutUint64(p.Data[p.Count*16+record*8:], math.Float64bits(float64(start)))
}
