package ops

import (
	"math"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
)

func TestPasteMixFloat32AcrossBlocksAndEOF(t *testing.T) {
	frames, start := audiobuf.BlockFrames+13, 5
	pairs := [][2]float32{
		{0.75, 0.75},
		{math.MaxFloat32, math.MaxFloat32},
		{-math.MaxFloat32, math.MaxFloat32},
		{math.Float32frombits(0x80000000), math.Float32frombits(0x80000000)},
		{math.SmallestNonzeroFloat32, math.SmallestNonzeroFloat32},
		{math.Float32frombits(0x007fffff), math.Float32frombits(0x00800000)},
	}
	left, right := make([]float32, start+frames-9), make([]float32, frames)
	for i := range left {
		left[i] = pairs[i%len(pairs)][0]
	}
	for i := range right {
		right[i] = pairs[(start+i)%len(pairs)][1]
	}
	source := document(t, left)
	clipboard, err := NewClipboard(document(t, right), Range{End: int64(frames), ChannelMask: 1})
	if err != nil {
		t.Fatal(err)
	}
	result, err := (Paste{Range{Start: int64(start), End: int64(start), ChannelMask: 1}, clipboard, PasteMix}).Apply(source)
	if err != nil {
		t.Fatal(err)
	}
	if result.Frames() != int64(start+frames) {
		t.Fatalf("frames %d want %d", result.Frames(), start+frames)
	}
	got := readDocument(t, result)[0]
	for i, sample := range got {
		var want float32
		switch {
		case i < start:
			want = left[i]
		case i < len(left):
			want = float32(float64(left[i]) + float64(right[i-start]))
		default:
			want = float32(float64(right[i-start]) + 0)
		}
		if math.Float32bits(sample) != math.Float32bits(want) {
			t.Fatalf("frame %d bits %08x want %08x", i, math.Float32bits(sample), math.Float32bits(want))
		}
	}
	assertSamples(t, source, [][]float32{left})
	clipboardSamples := make([]float32, frames)
	if got := clipboard.Read(clipboardSamples, 0, 0); got != frames {
		t.Fatalf("clipboard read %d want %d", got, frames)
	}
	for i, sample := range clipboardSamples {
		if math.Float32bits(sample) != math.Float32bits(right[i]) {
			t.Fatal("clipboard input changed")
		}
	}
}
