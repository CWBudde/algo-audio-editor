package audiobuf

import (
	"math"
	"reflect"
	"testing"

	"github.com/cwbudde/algo-dsp/dsp/fade"
)

func TestOwnedProcessedBlocksGoldenAndSourceOwnership(t *testing.T) {
	values := []float32{7, 1, 2, 3, 4, 9}
	source := NewChannel(values)
	for _, test := range []struct {
		name  string
		build func() (*Block, error)
		want  []float32
	}{
		{"fade", func() (*Block, error) { return NewFadedBlock(source, 1, 4, 0, 4, fade.Linear, true) }, []float32{0, 2.0 / 3, 2, 4}},
		{"remove DC", func() (*Block, error) { return NewDCRemovedBlock(source, 1, 4, 2.5) }, []float32{-1.5, -0.5, 0.5, 1.5}},
	} {
		t.Run(test.name, func(t *testing.T) {
			block, err := test.build()
			if err != nil {
				t.Fatal(err)
			}
			got := make([]float32, 4)
			block.Read(got, 0)
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("golden %v want%v", got, test.want)
			}
			peak, err := block.FinitePeak(0, 4)
			wantPeak := float64(0)
			for _, sample := range test.want {
				wantPeak = math.Max(wantPeak, math.Abs(float64(sample)))
			}
			if err != nil || peak != wantPeak {
				t.Fatalf("cachepeak%v/%v want%v", peak, err, wantPeak)
			}
			clear(got)
			block.Read(got, 0)
			if !reflect.DeepEqual(got, test.want) {
				t.Fatal("caller read mutated private output")
			}
			original := make([]float32, len(values))
			source.Read(original, 0)
			if !reflect.DeepEqual(original, values) {
				t.Fatal("source mutated")
			}
		})
	}
}

func TestOwnedProcessedBlockValidation(t *testing.T) {
	source := NewChannel([]float32{1, 2, 3, 4})
	for _, bounds := range []struct {
		start  int64
		frames int
	}{{-1, 1}, {5, 1}, {0, 0}, {0, BlockFrames + 1}, {3, 2}} {
		if _, err := NewFadedBlock(source, bounds.start, bounds.frames, 0, 4, fade.Linear, true); err == nil {
			t.Fatal("invalidfade source accepted")
		}
		if _, err := NewDCRemovedBlock(source, bounds.start, bounds.frames, 0); err == nil {
			t.Fatal("invalidDC source accepted")
		}
	}
	if _, err := NewFadedBlock(source, 0, 4, 2, 4, fade.Linear, true); err == nil {
		t.Fatal("invalidenvelope range accepted")
	}
	if _, err := NewFadedBlock(source, 0, 4, 0, 4, fade.Shape("unknown"), true); err == nil {
		t.Fatal("invalidcurve accepted")
	}
	if _, err := NewDCRemovedBlock(source, 0, 4, math.NaN()); err == nil {
		t.Fatal("undefinedmean accepted")
	}
}

func TestOwnedFadeGlobalPositionAndUnsafeMetadata(t *testing.T) {
	values := make([]float32, BlockFrames+4)
	for i := range values {
		values[i] = 1
	}
	source := NewChannel(values)
	block, err := NewFadedBlock(source, BlockFrames-2, 6, 2, 8, fade.Linear, false)
	if err != nil {
		t.Fatal(err)
	}
	got := make([]float32, 6)
	block.Read(got, 0)
	for i, sample := range got {
		want := float32(1 - float64(i+2)/7)
		if sample != want {
			t.Fatalf("position%d got%v want%v", i, sample, want)
		}
	}
	unsafe := []float32{math.Float32frombits(0x80000000), math.Float32frombits(0x7f812345), math.Float32frombits(0xff800000), 2}
	original := NewChannel(unsafe)
	block, err = NewFadedBlock(original, 0, 4, 0, 4, fade.Linear, true)
	if err != nil {
		t.Fatal(err)
	}
	block.Read(got[:4], 0)
	if math.Float32bits(got[0]) != 0x80000000 || !math.IsNaN(float64(got[1])) || !math.IsInf(float64(got[2]), -1) || got[3] != 2 {
		t.Fatalf("IEEEoutput %v", got[:4])
	}
	if _, err := block.FinitePeak(0, 4); err == nil {
		t.Fatal("nonfiniteoutput hidden by cachedsummaries")
	}
	copySource := make([]float32, 4)
	original.Read(copySource, 0)
	for i := range unsafe {
		if math.Float32bits(copySource[i]) != math.Float32bits(unsafe[i]) {
			t.Fatal("sourcebits changed")
		}
	}
}
