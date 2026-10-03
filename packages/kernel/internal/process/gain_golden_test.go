package process

import (
	"math"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
)

// These checked-in IEEE-754 vectors are independent of the Go gain adapter.
// Inputs are -3, -1, -.25, -0, +0, .125, .5, 1, 3, and the float32 value
// nearest 12345.678. Half/double and gains 1e-6/1000 were reviewed directly;
// +/-6 dB vectors were derived offline with ECMAScript Math.pow(10, db/20),
// multiplication of the decoded input bits, and DataView.setFloat32 rounding.
// No expected value is calculated by the production DSP at test runtime.
func TestGainStaticIEEEGoldens(t *testing.T) {
	inputBits := []uint32{0xc0400000, 0xbf800000, 0xbe800000, 0x80000000, 0x00000000, 0x3e000000, 0x3f000000, 0x3f800000, 0x40400000, 0x4640e6b6}
	input := valuesFromBits(inputBits)
	for _, tt := range []struct {
		name string
		db   float64
		want []uint32
	}{
		{"half", -6.020599913279624, []uint32{0xbfc00000, 0xbf000000, 0xbe000000, 0x80000000, 0x00000000, 0x3d800000, 0x3e800000, 0x3f000000, 0x3fc00000, 0x45c0e6b6}},
		{"double", 6.020599913279624, []uint32{0xc0c00000, 0xc0000000, 0xbf000000, 0x80000000, 0x00000000, 0x3e800000, 0x3f800000, 0x40000000, 0x40c00000, 0x46c0e6b6}},
		{"minimum_db", -120, []uint32{0xb649539c, 0xb58637bd, 0xb48637bd, 0x80000000, 0x00000000, 0x340637bd, 0x350637bd, 0x358637bd, 0x3649539c, 0x3c4a4587}},
		{"maximum_db", 60, []uint32{0xc53b8000, 0xc47a0000, 0xc37a0000, 0x80000000, 0x00000000, 0x42fa0000, 0x43fa0000, 0x447a0000, 0x453b8000, 0x4b3c614e}},
		{"minus_six", -6, []uint32{0xbfc074b6, 0xbf004dce, 0xbe004dce, 0x80000000, 0x00000000, 0x3d804dce, 0x3e804dce, 0x3f004dce, 0x3fc074b6, 0x45c15bf8}},
		{"plus_six", 6, []uint32{0xc0bf8b91, 0xbfff64c1, 0xbeff64c1, 0x80000000, 0x00000000, 0x3e7f64c1, 0x3f7f64c1, 0x3fff64c1, 0x40bf8b91, 0x46c071bb}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			document := fixture(t, input)
			builder, err := NewBuilder(document, ops.Range{End: int64(len(input)), ChannelMask: 1}, Gain{DB: tt.db}, Limits{})
			if err != nil {
				t.Fatal(err)
			}
			result := finish(t, builder)
			assertBits(t, samples(t, result, 0), valuesFromBits(tt.want))
			assertBits(t, samples(t, document, 0), input)
			if peak, nonfinite := builder.Peak(); peak != float64(math.Float32frombits(tt.want[len(tt.want)-1])) || nonfinite {
				t.Fatalf("static peak %v/%t", peak, nonfinite)
			}
		})
	}
}

func TestGainZeroStaticSpecialBits(t *testing.T) {
	// Include both signs of zero/subnormal/infinity, maximum finite values,
	// and distinct quiet/signaling NaN payloads. Identity must not round them.
	bits := []uint32{0x00000000, 0x80000000, 0x00000001, 0x80000001, 0x7f7fffff, 0xff7fffff, 0x7f800000, 0xff800000, 0x7fc12345, 0xffc54321, 0x7f812345, 0xff854321}
	input := valuesFromBits(bits)
	document := fixture(t, input)
	builder, err := NewBuilder(document, ops.Range{End: int64(len(input)), ChannelMask: 1}, Gain{}, Limits{MaxOutputBytes: 1})
	if err != nil {
		t.Fatal(err)
	}
	assertBits(t, samples(t, finish(t, builder), 0), input)
	if peak, nonfinite := builder.Peak(); peak != float64(math.Float32frombits(0x7f7fffff)) || !nonfinite {
		t.Fatalf("special identity peak %v/%t", peak, nonfinite)
	}
}

func TestRoundedOutputCompactionPreservesUnreadDSPValues(t *testing.T) {
	// A finite float64 overflowing float32 must be excluded from finite peak.
	// Leading specials make compact writes trail reads, exercising the fused
	// conversion loop rather than only its all-finite in-place path.
	output := []float64{math.NaN(), math.Inf(1), math.Inf(-1), 999, 0.5, float64(math.MaxFloat32) * 2, float64(math.SmallestNonzeroFloat32), -2}
	document := fixture(t, make([]float32, len(output)))
	factory := processFunc(func(_, _ int, _ int64) (Processor, error) {
		return processorFunc(func(block []float64) error { copy(block, output); return nil }), nil
	})
	builder, err := NewBuilder(document, ops.Range{End: int64(len(output)), ChannelMask: 1}, factory, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	result := finish(t, builder)
	want := make([]float32, len(output))
	for i, value := range output {
		want[i] = float32(value)
	}
	assertBits(t, samples(t, result, 0), want)
	if peak, nonfinite := builder.Peak(); peak != 999 || !nonfinite {
		t.Fatalf("rounded compact peak %v/%t", peak, nonfinite)
	}
}

func valuesFromBits(bits []uint32) []float32 {
	values := make([]float32, len(bits))
	for i, value := range bits {
		values[i] = math.Float32frombits(value)
	}
	return values
}
