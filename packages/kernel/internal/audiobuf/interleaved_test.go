package audiobuf

import (
	"fmt"
	"math"
	"testing"
)

func TestBlockFromInterleavedOwnershipAndBits(t *testing.T) {
	bits := []uint32{0x80000000, 0, 0x3f000000, 0xbf800000, 0x7f800000, 0xff800000, 0x7fc01234, 0xffc05678, 0x7f801234, 1, 0x80000001}
	for _, channels := range []int{1, 2, 6, 8} {
		samples := make([]float32, len(bits)*channels)
		for i := range samples {
			samples[i] = math.Float32frombits(bits[(i+i/channels)%len(bits)])
		}
		blocks := make([]*Block, channels)
		for channel := range channels {
			block, err := NewBlockFromInterleaved(samples, channel, channels)
			if err != nil {
				t.Fatalf("channels=%d channel=%d: %v", channels, channel, err)
			}
			blocks[channel] = block
			want := make([]float32, len(bits))
			for frame := range want {
				want[frame] = samples[frame*channels+channel]
			}
			assertSamples(t, channelFromBlocks([]*Block{block}), want)
			reference, err := NewBlock(want)
			if err != nil {
				t.Fatal(err)
			}
			for level, peaks := range block.peaks {
				if len(peaks) != len(reference.peaks[level]) {
					t.Fatalf("channel %d missing peak level %d", channel, level)
				}
				for i, peak := range peaks {
					wantPeak := reference.peaks[level][i]
					if math.Float32bits(peak.min) != math.Float32bits(wantPeak.min) || math.Float32bits(peak.max) != math.Float32bits(wantPeak.max) || math.Float64bits(peak.energy) != math.Float64bits(wantPeak.energy) {
						t.Fatalf("channel %d peak level %d bucket %d differs from mono constructor", channel, level, i)
					}
				}
			}
		}
		clear(samples)
		for channel, block := range blocks {
			got := make([]float32, len(bits))
			if n := block.Read(got, 0); n != len(got) {
				t.Fatalf("channel %d read %d samples", channel, n)
			}
			for frame, sample := range got {
				index := frame*channels + channel
				if math.Float32bits(sample) != bits[(index+frame)%len(bits)] {
					t.Fatalf("channel %d frame %d changed through caller input", channel, frame)
				}
			}
			original := math.Float32bits(got[0])
			got[0] = 123
			if block.Read(got[:1], 0) != 1 || math.Float32bits(got[0]) != original {
				t.Fatalf("channel %d read destination aliases block samples", channel)
			}
		}
	}
}

// BenchmarkInterleavedCopy isolates sample movement from allocation and peaks.
// The scalar reference is the original constructor's channel extraction loop.
func BenchmarkInterleavedCopy(b *testing.B) {
	for _, channels := range []int{1, 2, 6, 8} {
		samples := make([]float32, BlockFrames*channels)
		for i := range samples {
			samples[i] = float32(i)
		}
		dst := make([]float32, BlockFrames)
		copies := []struct {
			name string
			copy func([]float32, []float32, int, int)
		}{
			{"scalar", copyInterleavedScalar},
			{"optimized", copyInterleavedChannel},
		}
		for _, candidate := range copies {
			b.Run(fmt.Sprintf("channels%d/%s", channels, candidate.name), func(b *testing.B) {
				b.SetBytes(int64(len(dst) * 4))
				b.ReportAllocs()
				for b.Loop() {
					candidate.copy(dst, samples, channels-1, channels)
				}
			})
		}
	}
}

func copyInterleavedScalar(dst, samples []float32, channel, channels int) {
	for i := range dst {
		dst[i] = samples[i*channels+channel]
	}
}

func TestBlockFromInterleavedCopyBoundaries(t *testing.T) {
	bits := []uint32{0, 0x80000000, 1, 0x80000001, 0x3f800000, 0xbf800000, 0x7f800000, 0xff800000, 0x7fc01234, 0xffc05678, 0x7f801234}
	for channels := 1; channels <= 8; channels++ {
		for _, frames := range []int{1, 7, 8, 9, 15, 16, 17, 255, 256, 257, BlockFrames - 1, BlockFrames} {
			t.Run(fmt.Sprintf("channels%d/frames%d", channels, frames), func(t *testing.T) {
				samples := make([]float32, frames*channels)
				for i := range samples {
					samples[i] = math.Float32frombits(bits[(i+i/channels)%len(bits)])
				}
				for channel := range channels {
					block, err := NewBlockFromInterleaved(samples, channel, channels)
					if err != nil {
						t.Fatal(err)
					}
					got, want := make([]float32, frames), make([]float32, frames)
					copyInterleavedScalar(want, samples, channel, channels)
					if n := block.Read(got, 0); n != frames {
						t.Fatalf("channel %d read %d frames, want %d", channel, n, frames)
					}
					for i := range got {
						if math.Float32bits(got[i]) != math.Float32bits(want[i]) {
							t.Fatalf("channel %d frame %d: bits %08x, want %08x", channel, i, math.Float32bits(got[i]), math.Float32bits(want[i]))
						}
					}
				}
			})
		}
	}
}

func TestBlockFromInterleavedValidation(t *testing.T) {
	for _, tt := range []struct {
		name              string
		samples           []float32
		channel, channels int
	}{
		{"zero channels", []float32{1}, 0, 0},
		{"negative channels", []float32{1}, 0, -1},
		{"negative channel", []float32{1, 2}, -1, 2},
		{"channel at end", []float32{1, 2}, 2, 2},
		{"partial frame", []float32{1, 2, 3}, 0, 2},
		{"empty", nil, 0, 1},
		{"oversized", make([]float32, (BlockFrames+1)*2), 1, 2},
		{"huge layout", []float32{1}, 0, math.MaxInt},
	} {
		t.Run(tt.name, func(t *testing.T) {
			block, err := NewBlockFromInterleaved(tt.samples, tt.channel, tt.channels)
			if err == nil || block != nil {
				t.Fatalf("invalid input returned block=%v error=%v", block, err)
			}
		})
	}
	for _, frames := range []int{1, BlockFrames} {
		block, err := NewBlockFromInterleaved(make([]float32, frames*2), 1, 2)
		if err != nil || block.Frames() != frames {
			t.Fatalf("%d-frame block = %v, error %v", frames, block, err)
		}
	}
}
