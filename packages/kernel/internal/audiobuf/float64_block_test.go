package audiobuf

import (
	"math"
	"strconv"
	"testing"
)

func TestNewBlockFromFloat64RoundingAndOwnership(t *testing.T) {
	values := []float64{
		0, math.Copysign(0, -1), math.SmallestNonzeroFloat32 / 2, math.SmallestNonzeroFloat32,
		1 + math.Ldexp(1, -24), 1 + math.Ldexp(3, -24), math.MaxFloat32, math.MaxFloat64,
		math.Inf(-1), math.NaN(), -.25,
	}
	for _, frames := range []int{1, 7, 8, 9, 11, BlockFrames} {
		t.Run(strconv.Itoa(frames), func(t *testing.T) {
			input, rounded := make([]float64, frames), make([]float32, frames)
			for i := range input {
				input[i] = values[i%len(values)]
				rounded[i] = float32(input[i])
			}
			block, err := NewBlockFromFloat64(input)
			if err != nil {
				t.Fatal(err)
			}
			clear(input)
			output := make([]float32, frames)
			if n := block.Read(output, 0); n != frames {
				t.Fatal("short copy", n)
			}
			for i := range output {
				if math.Float32bits(output[i]) != math.Float32bits(rounded[i]) {
					t.Fatalf("sample %d differs: %08x != %08x", i, math.Float32bits(output[i]), math.Float32bits(rounded[i]))
				}
			}
			output[0] = 123
			if block.Read(output[:1], 0) != 1 || math.Float32bits(output[0]) != math.Float32bits(rounded[0]) {
				t.Fatal("read buffer changed owned samples")
			}
			// Cached summaries match the established float32 copy constructor,
			// including its first-NaN extrema and poisoned energy semantics.
			reference, err := NewBlock(rounded)
			if err != nil {
				t.Fatal(err)
			}
			for level := range block.peaks {
				for i, got := range block.peaks[level] {
					want := reference.peaks[level][i]
					if math.Float32bits(got.min) != math.Float32bits(want.min) || math.Float32bits(got.max) != math.Float32bits(want.max) || math.Float64bits(got.energy) != math.Float64bits(want.energy) {
						t.Fatal("cached summary differs", level, i)
					}
				}
			}
		})
	}
}

func TestNewBlockFromFloat64InvalidLengths(t *testing.T) {
	for _, input := range [][]float64{nil, {}, make([]float64, BlockFrames+1)} {
		if block, err := NewBlockFromFloat64(input); err == nil || block != nil {
			t.Fatal("invalid input accepted")
		}
	}
}
