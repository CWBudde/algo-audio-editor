package process

import (
	"math"
	"reflect"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
)

func TestStereoToMonoFloat32AcrossBlocks(t *testing.T) {
	frames := audiobuf.BlockFrames + 13
	pairs := [][2]float32{
		{0.75, 0.25},
		{math.MaxFloat32, math.MaxFloat32},
		{-math.MaxFloat32, math.MaxFloat32},
		{math.Float32frombits(0x80000000), math.Float32frombits(0x80000000)},
		{math.SmallestNonzeroFloat32, math.Float32frombits(2)},
		{math.Float32frombits(0x007fffff), math.Float32frombits(0x00800000)},
		{-math.SmallestNonzeroFloat32, 0},
	}
	left, right := make([]float32, frames), make([]float32, frames)
	for i := range left {
		left[i], right[i] = pairs[i%len(pairs)][0], pairs[i%len(pairs)][1]
	}
	source := operationDocument(t, left, right)
	stepper, err := NewOperation(source, ops.Range{Start: 17, End: 18, ChannelMask: 1}, Settings{Operation: "stereo-to-mono", ChannelMode: "mix"}, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	result := finishOperation(t, stepper)
	if result.Channels() != 1 || result.Frames() != int64(frames) || result.SampleRate() != source.SampleRate() || !reflect.DeepEqual(result.Metadata(), source.Metadata()) {
		t.Fatal("downmix changed duration, rate or metadata")
	}
	for i, sample := range operationSamples(t, result, 0) {
		want := float32((float64(left[i]) + float64(right[i])) * 0.5)
		if math.Float32bits(sample) != math.Float32bits(want) {
			t.Fatalf("frame %d bits %08x want %08x", i, math.Float32bits(sample), math.Float32bits(want))
		}
	}
	peak, nonfinite := stepper.(*blockOperation).Peak()
	if peak != math.MaxFloat32 || nonfinite {
		t.Fatalf("finite large inputs produced incorrect telemetry %v/%v", peak, nonfinite)
	}
	for channel, want := range [][]float32{left, right} {
		for i, sample := range operationSamples(t, source, channel) {
			if math.Float32bits(sample) != math.Float32bits(want[i]) {
				t.Fatal("downmix modified source")
			}
		}
	}
}

func TestStereoToMonoFloat32RenderAllocations(t *testing.T) {
	source := operationDocument(t, make([]float32, 4096), make([]float32, 4096))
	stepper, err := NewOperation(source, ops.Range{End: 4096, ChannelMask: 3}, Settings{Operation: "stereo-to-mono", ChannelMode: "mix"}, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	job := stepper.(*blockOperation)
	if allocations := testing.AllocsPerRun(10, func() {
		if err := job.render(0, 4096); err != nil {
			t.Fatal(err)
		}
	}); allocations != 0 {
		t.Fatalf("downmix render allocations = %v", allocations)
	}
}
