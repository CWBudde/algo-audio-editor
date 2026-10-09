package process

import (
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func audioSettings(audio []float32, rate int) Settings {
	return Settings{Operation: protocol.OperationGenerate, Generator: protocol.GeneratorAudio, Audio: audio, AudioRate: rate}
}

func TestAudioGeneratorPlacement(t *testing.T) {
	speech := []float32{0.1, 0.2, 0.3}
	tests := []struct {
		name        string
		selected    ops.Range
		level       float64
		left, right []float32
		regionEnd   int64
		output      ops.Range
	}{
		{"insert at cursor on both channels", ops.Range{Start: 2, End: 2, ChannelMask: 3}, 0, []float32{1, 2, 0.1, 0.2, 0.3, 3, 4}, []float32{5, 6, 0.1, 0.2, 0.3, 7, 8}, 7, ops.Range{Start: 2, End: 5, ChannelMask: 3}},
		{"insert at cursor on one channel", ops.Range{Start: 2, End: 2, ChannelMask: 1}, 0, []float32{1, 2, 0.1, 0.2, 0.3, 3, 4}, []float32{5, 6, 0, 0, 0, 7, 8}, 7, ops.Range{Start: 2, End: 5, ChannelMask: 1}},
		{"replace a shorter selection", ops.Range{Start: 1, End: 3, ChannelMask: 3}, 0, []float32{1, 0.1, 0.2, 0.3, 4}, []float32{5, 0.1, 0.2, 0.3, 8}, 5, ops.Range{Start: 1, End: 4, ChannelMask: 3}},
		// Replacing a region's whole span removes it, as a paste over it does.
		{"replace a longer selection", ops.Range{Start: 0, End: 4, ChannelMask: 3}, 0, []float32{0.1, 0.2, 0.3}, []float32{0.1, 0.2, 0.3}, 0, ops.Range{Start: 0, End: 3, ChannelMask: 3}},
		{"grow a one-channel selection", ops.Range{Start: 1, End: 3, ChannelMask: 1}, 0, []float32{1, 0.1, 0.2, 0.3, 4}, []float32{5, 6, 7, 0, 8}, 5, ops.Range{Start: 1, End: 4, ChannelMask: 1}},
		{"keep a longer one-channel selection", ops.Range{Start: 0, End: 4, ChannelMask: 2}, 0, []float32{1, 2, 3, 4}, []float32{0.1, 0.2, 0.3, 0}, 4, ops.Range{Start: 0, End: 4, ChannelMask: 2}},
		{"scale by the level", ops.Range{Start: 4, End: 4, ChannelMask: 3}, -20 * math.Log10(2), []float32{1, 2, 3, 4, 0.05, 0.1, 0.15}, []float32{5, 6, 7, 8, 0.05, 0.1, 0.15}, 4, ops.Range{Start: 4, End: 7, ChannelMask: 3}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			document := operationDocument(t, []float32{1, 2, 3, 4}, []float32{5, 6, 7, 8})
			settings := audioSettings(append([]float32(nil), speech...), 48000)
			settings.LevelDB = tc.level
			stepper, err := NewOperation(document, tc.selected, settings, Limits{})
			if err != nil {
				t.Fatal(err)
			}
			if got := stepper.(*blockOperation).OutputSelection(); got != tc.output {
				t.Fatalf("output selection %+v, want %+v", got, tc.output)
			}
			result := finishOperation(t, stepper)
			for channel, want := range [][]float32{tc.left, tc.right} {
				got := operationSamples(t, result, channel)
				if len(got) != len(want) {
					t.Fatalf("channel %d = %v, want %v", channel, got, want)
				}
				for i := range want {
					if math.Abs(float64(got[i]-want[i])) > 1e-6 {
						t.Fatalf("channel %d = %v, want %v", channel, got, want)
					}
				}
			}
			regions := result.Metadata().Timeline.Regions
			switch {
			case tc.regionEnd == 0 && len(regions) != 0:
				t.Fatalf("regions %+v, want none", regions)
			case tc.regionEnd != 0 && (len(regions) != 1 || regions[0].End != tc.regionEnd):
				t.Fatalf("regions %+v, want one ending at %d", regions, tc.regionEnd)
			}
		})
	}
}

func TestAudioGeneratorResamplesToTheDocumentRate(t *testing.T) {
	const sourceRate, frames = 24000, 2400
	speech := make([]float32, frames)
	for i := range speech {
		speech[i] = float32(0.5 * math.Sin(2*math.Pi*1000*float64(i)/sourceRate))
	}
	document := operationDocument(t, make([]float32, 8))
	stepper, err := NewOperation(document, ops.Range{Start: 8, End: 8, ChannelMask: 1}, audioSettings(speech, sourceRate), Limits{})
	if err != nil {
		t.Fatal(err)
	}
	result := finishOperation(t, stepper)
	if result.Frames() != 8+2*frames {
		t.Fatalf("frames %d, want %d", result.Frames(), 8+2*frames)
	}
	got := operationSamples(t, result, 0)[8:]
	peak := 0.0
	for _, v := range got[200 : len(got)-200] {
		peak = math.Max(peak, math.Abs(float64(v)))
	}
	if peak < 0.48 || peak > 0.52 {
		t.Fatalf("1 kHz tone peak after resampling %.3f, want 0.5", peak)
	}
	// Two output frames per input frame: the tone's 48-frame period.
	if math.Abs(float64(got[1000]-got[1048])) > 0.01 {
		t.Fatalf("resampled tone is not periodic at 48 kHz: %v vs %v", got[1000], got[1048])
	}
}

func TestAudioGeneratorRejectsInvalidInput(t *testing.T) {
	document := operationDocument(t, []float32{1, 2, 3, 4})
	cursor := ops.Range{Start: 0, End: 0, ChannelMask: 1}
	tests := []struct {
		name     string
		settings Settings
		limits   Limits
		want     string
	}{
		{"no samples", audioSettings(nil, 24000), Limits{}, "needs samples"},
		{"no rate", audioSettings([]float32{0}, 0), Limits{}, "audio rate"},
		{"rate too high", audioSettings([]float32{0}, 768000), Limits{}, "audio rate"},
		{"NaN sample", audioSettings([]float32{0, float32(math.NaN())}, 48000), Limits{}, "finite"},
		{"infinite sample", audioSettings([]float32{float32(math.Inf(1))}, 48000), Limits{}, "finite"},
		{"resampling over budget", audioSettings(make([]float32, 1000), 24000), Limits{MaxOutputBytes: 1024}, "budget"},
		{"level above 0 dB", Settings{Operation: protocol.OperationGenerate, Generator: protocol.GeneratorAudio, Audio: []float32{0}, AudioRate: 48000, LevelDB: 3}, Limits{}, "level"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := NewOperation(document, cursor, tc.settings, tc.limits)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("NewOperation = %v, want an error containing %q", err, tc.want)
			}
		})
	}
}

func TestAudioGeneratorSharesBlocksAndAccountsForItsSamples(t *testing.T) {
	document := operationDocument(t, []float32{1, 2}, []float32{3, 4})
	speech := []float32{0.5, -0.5, 0.25}
	stepper, err := NewOperation(document, ops.Range{Start: 1, End: 1, ChannelMask: 3}, audioSettings(speech, 48000), Limits{})
	if err != nil {
		t.Fatal(err)
	}
	block := stepper.(*blockOperation)
	if want := int64((3*2 + 3) * 4); block.MaterializedBytes() != want {
		t.Fatalf("materialized bytes %d, want %d (two channels plus the kept samples)", block.MaterializedBytes(), want)
	}
	result := finishOperation(t, stepper)
	left, right := operationSamples(t, result, 0), operationSamples(t, result, 1)
	if !reflect.DeepEqual(left[1:4], speech) || !reflect.DeepEqual(right[1:4], speech) {
		t.Fatalf("both channels must carry the speech: %v / %v", left, right)
	}
	if block.audio != nil {
		t.Fatal("finished operation still holds the supplied samples")
	}
}
