package audiobuf

import (
	"errors"
	"math"
	"testing"

	timestats "github.com/cwbudde/algo-dsp/stats/time"
)

func assertFinitePeak(t *testing.T, channel Channel, input []float32, start, end int64) {
	t.Helper()
	got, err := channel.FinitePeak(start, end)
	if err != nil {
		t.Fatalf("FinitePeak[%d,%d): %v", start, end, err)
	}
	stats := timestats.Summary(input[start:end])
	want := math.Max(math.Abs(stats.Min), math.Abs(stats.Max))
	if math.Float64bits(got) != math.Float64bits(want) {
		t.Fatalf("FinitePeak[%d,%d)=%g, want exact %g", start, end, got, want)
	}
}

func TestFinitePeakExactCachedAndRawExtents(t *testing.T) {
	input := peakSamples(2*BlockFrames + 4173)
	channel := NewChannel(input)
	// Cross products exercise all cache levels, raw ends, empty intervals,
	// block boundaries and the incomplete final cached buckets.
	cuts := []int64{0, 1, 17, 255, 256, 257, 4095, 4096, 4097, 65535, 65536, 65537, 2*BlockFrames - 1, 2 * BlockFrames, int64(len(input)) - 1, int64(len(input))}
	for i, start := range cuts {
		for _, end := range cuts[i:] {
			assertFinitePeak(t, channel, input, start, end)
		}
	}
	for _, interval := range [][2]int64{{-1, 0}, {2, 1}, {0, int64(len(input)) + 1}} {
		if _, err := channel.FinitePeak(interval[0], interval[1]); err == nil {
			t.Fatalf("invalid interval %v accepted", interval)
		}
	}
	var empty Channel
	if peak, err := empty.FinitePeak(0, 0); err != nil || math.Float64bits(peak) != 0 {
		t.Fatal("empty channel must return positive zero", peak, err)
	}
}

func TestFinitePeakSpecialsAtEveryCacheAndBlockBoundary(t *testing.T) {
	const frames = BlockFrames + 7
	for _, position := range []int{0, 1, 127, 255, 256, 257, 4095, 4096, 4097, BlockFrames - 1, BlockFrames, frames - 1} {
		for _, special := range []uint32{0x7f812345, 0xffc54321, 0x7f800000, 0xff800000} {
			input := make([]float32, frames)
			for i := range input {
				input[i] = .5
			}
			input[position] = math.Float32frombits(special)
			channel := NewChannel(input)
			for _, interval := range [][2]int64{{0, frames}, {int64(position), int64(position + 1)}} {
				if peak, err := channel.FinitePeak(interval[0], interval[1]); !errors.Is(err, ErrNonFiniteSamples) || peak != 0 {
					t.Fatalf("position=%d bits=%08x range=%v: peak=%g error=%v", position, special, interval, peak, err)
				}
			}
			// Excluding the special must not inherit a poisoned coarser cache.
			assertFinitePeak(t, channel, input, 0, int64(position))
			assertFinitePeak(t, channel, input, int64(position+1), frames)
			read := make([]float32, 1)
			if channel.Read(read, int64(position)) != 1 || math.Float32bits(read[0]) != special || math.Float32bits(input[position]) != special {
				t.Fatal("finite query altered source special bits")
			}
		}
	}
}

func TestFinitePeakRejectsHiddenNaNBeforeReducingExtrema(t *testing.T) {
	input := make([]float32, BlockFrames)
	for i := range input {
		input[i] = .5
	}
	input[17] = math.Float32frombits(0x7f812345)
	channel := NewChannel(input)
	for level := range peakFrames {
		summary := channel.blocks[0].peaks[level][0]
		if summary.min != .5 || summary.max != .5 || !math.IsNaN(summary.energy) {
			t.Fatal("fixture must hide NaN behind finite extrema at every cache level")
		}
		if _, err := channel.FinitePeak(0, peakFrames[level]); !errors.Is(err, ErrNonFiniteSamples) {
			t.Fatal("finite extrema concealed a cached NaN", err)
		}
	}
}

func TestFinitePeakExactRangeIgnoresOutsideNonfiniteAndLargerPeaks(t *testing.T) {
	input := make([]float32, 513)
	for i := range input {
		input[i] = .25
	}
	input[0], input[255], input[256], input[512] = float32(math.NaN()), float32(math.Inf(-1)), float32(math.Inf(1)), math.MaxFloat32
	channel := NewChannel(input)
	for _, interval := range [][2]int64{{1, 255}, {257, 512}, {400, 411}} {
		assertFinitePeak(t, channel, input, interval[0], interval[1])
	}
	assertFinitePeak(t, channel, input, 512, 513)
	if _, err := channel.FinitePeak(256, 257); !errors.Is(err, ErrNonFiniteSamples) {
		t.Fatal("exact single infinity was missed", err)
	}
}

func TestFinitePeakSignedZeroAndMaximumFiniteHaveFiniteEnergy(t *testing.T) {
	for _, input := range [][]float32{
		{math.Float32frombits(0x80000000), 0, math.Float32frombits(0x80000000)},
		{math.MaxFloat32, -math.MaxFloat32, math.Float32frombits(1), math.Float32frombits(0x80000000)},
	} {
		channel := NewChannel(input)
		assertFinitePeak(t, channel, input, 0, int64(len(input)))
		read := make([]float32, len(input))
		channel.Read(read, 0)
		for i := range input {
			if math.Float32bits(read[i]) != math.Float32bits(input[i]) {
				t.Fatal("finite peak query rewrote signed zeros/finite samples")
			}
		}
	}
	input := make([]float32, BlockFrames)
	for i := range input {
		input[i] = math.MaxFloat32
	}
	assertFinitePeak(t, NewChannel(input), input, 0, BlockFrames)
}

func TestFinitePeakArbitraryShortBlocksAndAllocationFreeQueries(t *testing.T) {
	var input []float32
	var blocks []*Block
	for _, frames := range []int{1, 255, 257, 4097, 31, BlockFrames, 17} {
		values := peakSamples(frames)
		block, err := NewBlock(values)
		if err != nil {
			t.Fatal(err)
		}
		blocks = append(blocks, block)
		input = append(input, values...)
	}
	channel, err := NewChannelFromBlocks(blocks)
	if err != nil {
		t.Fatal(err)
	}
	for _, interval := range [][2]int64{{0, int64(len(input))}, {1, 256}, {255, 513}, {300, 5000}, {4095, 65536}, {65530, int64(len(input)) - 1}} {
		assertFinitePeak(t, channel, input, interval[0], interval[1])
	}
	allocations := testing.AllocsPerRun(100, func() {
		if peak, err := channel.FinitePeak(17, int64(len(input))-9); err != nil || peak <= 0 {
			panic("validated finite query failed")
		}
	})
	if allocations != 0 {
		t.Fatalf("finite cached query allocated %g times", allocations)
	}
}

func TestBlockFinitePeakExactRangesAndInvalidBounds(t *testing.T) {
	input := peakSamples(BlockFrames)
	input[0] = float32(math.Inf(1))
	input[255] = math.Float32frombits(0x7f812345)
	block, err := NewBlock(input)
	if err != nil {
		t.Fatal(err)
	}
	for _, interval := range [][2]int{{1, 255}, {256, 4096}, {4095, BlockFrames}, {BlockFrames, BlockFrames}} {
		peak, err := block.FinitePeak(interval[0], interval[1])
		stats := timestats.Summary(input[interval[0]:interval[1]])
		want := math.Max(math.Abs(stats.Min), math.Abs(stats.Max))
		if err != nil || math.Float64bits(peak) != math.Float64bits(want) {
			t.Fatal("block query overreached its exact finite range", interval, peak, want, err)
		}
	}
	if _, err := block.FinitePeak(0, BlockFrames); !errors.Is(err, ErrNonFiniteSamples) {
		t.Fatal("complete nonfinite block accepted", err)
	}
	for _, interval := range [][2]int{{-1, 0}, {1, 0}, {0, BlockFrames + 1}} {
		if _, err := block.FinitePeak(interval[0], interval[1]); err == nil {
			t.Fatal("invalid block range accepted", interval)
		}
	}
	var missing *Block
	if _, err := missing.FinitePeak(0, 0); err == nil {
		t.Fatal("missing block accepted")
	}
	if allocations := testing.AllocsPerRun(100, func() {
		if _, err := block.FinitePeak(256, BlockFrames); err != nil {
			panic("validated finite block range failed")
		}
	}); allocations != 0 {
		t.Fatalf("block query allocated %g times", allocations)
	}
}
