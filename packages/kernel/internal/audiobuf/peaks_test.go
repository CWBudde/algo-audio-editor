package audiobuf

import (
	"encoding/binary"
	"math"
	"slices"
	"testing"

	timestats "github.com/cwbudde/algo-dsp/stats/time"
)

func peakSamples(frames int) []float32 {
	samples := make([]float32, frames)
	for i := range samples {
		samples[i] = float32((i*17)%997-498) / 499
	}

	return samples
}

func peakRecord(data PeakData, i int) (minimum, maximum, rms float32, start int64, frames int) {
	minimum = math.Float32frombits(binary.LittleEndian.Uint32(data.Data[i*12:]))
	maximum = math.Float32frombits(binary.LittleEndian.Uint32(data.Data[i*12+4:]))
	rms = math.Float32frombits(binary.LittleEndian.Uint32(data.Data[i*12+8:]))
	frames = int(binary.LittleEndian.Uint32(data.Data[data.Count*12+i*4:]))
	start = int64(math.Float64frombits(binary.LittleEndian.Uint64(data.Data[data.Count*16+i*8:])))

	return minimum, maximum, rms, start, frames
}

func assertPeaks(t *testing.T, channel Channel, start, end int64, buckets int, wantSize int64) PeakData {
	t.Helper()
	data, err := channel.Peaks(start, end, buckets)
	if err != nil {
		t.Fatal(err)
	}
	if data.FramesPerBucket != wantSize || len(data.Data) != data.Count*24 {
		t.Fatalf("unexpected peak layout: size=%d count=%d bytes=%d", data.FramesPerBucket, data.Count, len(data.Data))
	}
	previousEnd := int64(-1)
	for i := range data.Count {
		minimum, maximum, rms, frame, count := peakRecord(data, i)
		if count < 1 || int64(count) > wantSize || frame >= end || frame+int64(count) <= start {
			t.Fatalf("record %d range [%d,%d) does not intersect [%d,%d)", i, frame, frame+int64(count), start, end)
		}
		if previousEnd >= 0 && previousEnd != frame {
			t.Fatalf("record %d starts at %d after %d", i, frame, previousEnd)
		}
		previousEnd = frame + int64(count)
		samples := make([]float32, count)
		if n := channel.Read(samples, frame); n != count {
			t.Fatalf("record %d reads %d of %d frames", i, n, count)
		}
		reference := make([]float64, count)
		for i, sample := range samples {
			reference[i] = float64(sample)
		}
		want := timestats.Calculate(reference)
		for _, extrema := range [][2]float32{{minimum, float32(want.Min)}, {maximum, float32(want.Max)}} {
			if math.Float32bits(extrema[0]) != math.Float32bits(extrema[1]) && !(math.IsNaN(float64(extrema[0])) && math.IsNaN(float64(extrema[1]))) {
				t.Fatalf("record %d extrema %v, want %v", i, extrema[0], extrema[1])
			}
		}
		if math.Float32bits(rms) != math.Float32bits(float32(want.RMS)) && !(math.IsNaN(float64(rms)) && math.IsNaN(want.RMS)) {
			if math.IsNaN(float64(rms)) || math.IsNaN(want.RMS) || math.IsInf(float64(rms), 0) || math.IsInf(want.RMS, 0) || math.Abs(float64(rms)-want.RMS) > 1e-7*want.RMS {
				t.Fatalf("record %d RMS=%v, want %v", i, rms, want.RMS)
			}
		}
	}

	return data
}

func TestPeaksLevelsAndRanges(t *testing.T) {
	channel := NewChannel(peakSamples(2*BlockFrames + 4173))
	for _, tt := range []struct {
		name       string
		start, end int64
		buckets    int
		size       int64
	}{
		{"single frame", 17, 18, 2000, 1},
		{"raw nonaligned", 7, 512, 7, 72},
		{"raw boundary", BlockFrames - 17, BlockFrames + 91, 7, 15},
		{"finest cached", 17, 2*BlockFrames + 4173, 256, 256},
		{"middle cached", 17, 2*BlockFrames + 4173, 16, 4096},
		{"coarsest cached", 17, 2*BlockFrames + 4173, 1, 65536},
		{"exact boundary", BlockFrames, 2 * BlockFrames, 256, 256},
		{"cached partial boundary", BlockFrames + 3, 2 * BlockFrames, 200, 256},
	} {
		t.Run(tt.name, func(t *testing.T) { assertPeaks(t, channel, tt.start, tt.end, tt.buckets, tt.size) })
	}
	for _, frames := range []int{1, 255, 256, 257, 4095, 4096, 4097, 65535, 65536, 65537} {
		channel := NewChannel(peakSamples(frames))
		size := int64(frames)
		for _, cachedSize := range peakFrames {
			if cachedSize <= int64(frames) {
				size = cachedSize
			}
		}
		assertPeaks(t, channel, 0, channel.Frames(), 1, size)
	}
}

func TestPeaksTailRMSUsesActualCount(t *testing.T) {
	samples := make([]float32, BlockFrames+17)
	for i := BlockFrames; i < len(samples); i++ {
		samples[i] = 1
	}
	channel := NewChannel(samples)
	data := assertPeaks(t, channel, 0, channel.Frames(), 1, 65536)
	minimum, maximum, rms, start, frames := peakRecord(data, 1)
	if minimum != 1 || maximum != 1 || rms != 1 || start != BlockFrames || frames != 17 {
		t.Fatalf("tail = %v/%v/%v at %d for %d frames", minimum, maximum, rms, start, frames)
	}
}

func TestPeaksEditsAndOwnership(t *testing.T) {
	samples := peakSamples(3*BlockFrames + 91)
	channel := NewChannel(samples)
	part, err := channel.Slice(13, 2*BlockFrames+19)
	if err != nil {
		t.Fatal(err)
	}
	joined := part.Concat(channel)
	for _, edited := range []Channel{part, joined} {
		for _, buckets := range []int{1, 32, 8192} {
			size := max(int64(1), edited.Frames()/int64(buckets))
			for _, cachedSize := range peakFrames {
				if cachedSize <= edited.Frames()/int64(buckets) {
					size = cachedSize
				}
			}
			data := assertPeaks(t, edited, 0, edited.Frames(), buckets, size)
			clear(data.Data)
			assertPeaks(t, edited, 0, edited.Frames(), buckets, size)
		}
	}
	assertSamples(t, channel, samples)
}

func TestPeaksSpecialValuesPreserveSamples(t *testing.T) {
	samples := peakSamples(BlockFrames)
	samples[256] = math.Float32frombits(0x7fc01234)
	samples[713] = float32(math.Inf(1))
	samples[901] = float32(math.Inf(-1))
	samples[1024] = math.Float32frombits(0x80000000)
	channel := NewChannel(samples)
	for _, tt := range []struct {
		buckets int
		size    int64
	}{{1, 65536}, {16, 4096}, {256, 256}, {8192, 8}} {
		assertPeaks(t, channel, 0, channel.Frames(), tt.buckets, tt.size)
	}
	assertSamples(t, channel, samples)
}

func TestPeaksCoarseRequestsUseOnlyCache(t *testing.T) {
	channel := NewChannel(peakSamples(BlockFrames))
	for _, buckets := range []int{1, 16, 256} {
		before, err := channel.Peaks(0, channel.Frames(), buckets)
		if err != nil {
			t.Fatal(err)
		}
		samples := slices.Clone(channel.blocks[0].samples)
		clear(channel.blocks[0].samples) // A raw scan would produce different extrema/RMS.
		after, err := channel.Peaks(0, channel.Frames(), buckets)
		copy(channel.blocks[0].samples, samples)
		if err != nil || !slices.Equal(before.Data, after.Data) {
			t.Fatalf("cached request read raw samples: %v", err)
		}
	}
}

func TestPeaksOffsetsBeyondInt32(t *testing.T) {
	block, err := NewBlock(peakSamples(BlockFrames))
	if err != nil {
		t.Fatal(err)
	}
	blocks := make([]*Block, math.MaxInt32/BlockFrames+2)
	for i := range blocks {
		blocks[i] = block
	}
	channel, err := NewChannelFromBlocks(blocks)
	if err != nil {
		t.Fatal(err)
	}
	start := int64(math.MaxInt32) + 23
	data := assertPeaks(t, channel, start, start+4096, 1, 4096)
	_, _, _, frame, _ := peakRecord(data, 0)
	if frame < math.MaxInt32 {
		t.Fatalf("peak offset truncated: %d", frame)
	}
}

func TestPeaksValidation(t *testing.T) {
	channel := NewChannel(peakSamples(256))
	for _, tt := range []struct {
		start, end int64
		buckets    int
	}{{-1, 1, 1}, {1, 0, 1}, {0, 257, 1}, {0, 256, 0}, {0, 256, 8193}, {0, math.MaxInt64, 1}} {
		if _, err := channel.Peaks(tt.start, tt.end, tt.buckets); err == nil {
			t.Fatalf("invalid request %+v accepted", tt)
		}
	}
	for _, channel := range []Channel{{}, channel} {
		data, err := channel.Peaks(0, 0, 1)
		if err != nil || data.Count != 0 || len(data.Data) != 0 {
			t.Fatalf("empty request = %+v, %v", data, err)
		}
	}
	block, err := NewBlock([]float32{1})
	if err != nil {
		t.Fatal(err)
	}
	blocks := make([]*Block, maxPeakRecords+1)
	for i := range blocks {
		blocks[i] = block
	}
	fragmented, err := NewChannelFromBlocks(blocks)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fragmented.Peaks(0, fragmented.Frames(), 1); err == nil {
		t.Fatal("excessive output accepted")
	}
	// Model a final block following an enormous prefix without allocating it.
	largeBlock, err := NewBlock(peakSamples(BlockFrames))
	if err != nil {
		t.Fatal(err)
	}
	unsafeChannel := Channel{blocks: []*Block{largeBlock}, offsets: []int64{maxSafeFrame - 300, maxSafeFrame - 300 + BlockFrames}}
	if _, err := unsafeChannel.Peaks(maxSafeFrame-300, maxSafeFrame, 1); err == nil {
		t.Fatal("cached bucket extending beyond a JS-safe frame accepted")
	}
	if _, err := unsafeChannel.Peaks(maxSafeFrame, maxSafeFrame+1, 1); err == nil {
		t.Fatal("unsafe requested frame accepted")
	}
}

func BenchmarkPeaksHourStereo2000(b *testing.B) {
	const frames = 48000 * 3600
	block, err := NewBlock(peakSamples(BlockFrames))
	if err != nil {
		b.Fatal(err)
	}
	tail, err := NewBlock(peakSamples(frames % BlockFrames))
	if err != nil {
		b.Fatal(err)
	}
	var channels [2]Channel
	for channel := range channels {
		blocks := make([]*Block, frames/BlockFrames, frames/BlockFrames+1)
		for i := range blocks {
			// Separate peak allocations model a real hour-long import. Only the
			// immutable sample fixture is shared to avoid allocating 1.3 GiB.
			copyBlock := &Block{samples: block.samples}
			for level := range block.peaks {
				copyBlock.peaks[level] = slices.Clone(block.peaks[level])
			}
			blocks[i] = copyBlock
		}
		blocks = append(blocks, tail)
		channels[channel], err = NewChannelFromBlocks(blocks)
		if err != nil {
			b.Fatal(err)
		}
	}
	b.ReportAllocs()
	for b.Loop() {
		for _, channel := range channels {
			data, err := channel.Peaks(0, frames, 2000)
			if err != nil || data.Count != frames/BlockFrames+1 {
				b.Fatalf("peaks count %d, error %v", data.Count, err)
			}
		}
	}
}
