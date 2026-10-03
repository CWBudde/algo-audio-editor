package audiobuf

import (
	"math"
	"testing"
)

func TestScaledBlockOwnedStorageIEEEAndFragmentedRange(t *testing.T) {
	input := []float32{-.5, math.Float32frombits(0x80000000), .25, 1, -2, .75}
	source := NewChannel(input[:3]).Concat(NewChannel(input[3:]))
	for _, gain := range []float64{.5, 2, math.Pow(10, .3), 1e-38, 1e38} {
		block, err := NewScaledBlock(source, 1, 4, gain)
		if err != nil {
			t.Fatal(err)
		}
		output := make([]float32, 4)
		block.Read(output, 0)
		for i, value := range output {
			want := float32(float64(input[i+1]) * gain)
			if math.Float32bits(value) != math.Float32bits(want) {
				t.Fatal("incorrect float32 rounding", value, want)
			}
		}
		output[0] = 123
		block.Read(output, 0)
		if output[0] != 0 {
			t.Fatal("returned read mutated private storage")
		}
	}
	unchanged := make([]float32, len(input))
	source.Read(unchanged, 0)
	for i := range input {
		if math.Float32bits(input[i]) != math.Float32bits(unchanged[i]) {
			t.Fatal("source changed")
		}
	}
	for _, tc := range []struct {
		start  int64
		frames int
		gain   float64
	}{{-1, 1, 1}, {0, 0, 1}, {5, 2, 1}, {0, 1, math.Inf(1)}} {
		if _, err := NewScaledBlock(source, tc.start, tc.frames, tc.gain); err == nil {
			t.Fatal("invalid constructor accepted", tc)
		}
	}
}
