package process

import (
	"context"
	"errors"
	"math"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

// quarterRateTone samples a sine at fs/4 with a 45° phase, so every stored
// sample sits at amplitude/√2 while the waveform between samples reaches the
// full amplitude: a sample peak 3 dB below the true peak.
func quarterRateTone(frames int, amplitude float64) []float32 {
	signal := make([]float32, frames)
	for i := range signal {
		signal[i] = float32(amplitude * math.Sin(math.Pi/2*float64(i)+math.Pi/4))
	}
	return signal
}

func TestNormalizeReportsOutputTruePeak(t *testing.T) {
	for _, operation := range []protocol.OperationName{protocol.OperationNormalizePeak, protocol.OperationNormalizeLoudness} {
		t.Run(string(operation), func(t *testing.T) {
			input := quarterRateTone(48000, .25)
			target := 0.0
			if operation == protocol.OperationNormalizeLoudness {
				target = -3
			}
			normalizer, err := NewNormalizer(fixture(t, input, input), ops.Range{End: 48000, ChannelMask: 3}, operation, target, Limits{})
			if err != nil {
				t.Fatal(err)
			}
			if normalizer.Status().TruePeak != nil {
				t.Fatal("true peak reported before the gain was resolved")
			}
			finishNormalizer(t, normalizer)
			status := normalizer.Status()
			if status.TruePeak == nil {
				t.Fatal("resolved normalization reported no true peak")
			}
			peak, _ := normalizer.Peak()
			// The 4x FIR estimate and the tone's abrupt onset overshoot the ideal
			// √2 slightly; the sample peak alone would miss the 3 dB.
			if want := peak * math.Sqrt2; *status.TruePeak < want*.995 || *status.TruePeak > want*1.015 {
				t.Fatalf("true peak %g, want about %g (sample peak %g)", *status.TruePeak, want, peak)
			}
			if status.InputTruePeak < .25*.995 || status.InputTruePeak > .25*1.015 || status.CeilingLimited {
				t.Fatalf("input true peak %g, limited %v", status.InputTruePeak, status.CeilingLimited)
			}
		})
	}
}

func TestNormalizeSilentReportsZeroTruePeak(t *testing.T) {
	input := make([]float32, 48000)
	normalizer, err := NewNormalizer(fixture(t, input), ops.Range{End: 48000, ChannelMask: 1}, protocol.OperationNormalizeLoudness, -23, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	if err := normalizer.LimitTruePeak(-1); err != nil {
		t.Fatal(err)
	}
	finishNormalizer(t, normalizer)
	if status := normalizer.Status(); status.TruePeak == nil || *status.TruePeak != 0 || status.CeilingLimited {
		t.Fatalf("silent status %+v", status)
	}
}

func TestNormalizeLoudnessTruePeakCeiling(t *testing.T) {
	for _, test := range []struct {
		name      string
		amplitude float64
		target    float64
		ceiling   float64
		limited   bool
	}{
		{"inactive below ceiling", .05, -23, -1, false},
		{"caps gain at ceiling", .1, -5, -6, true},
		{"caps a full-scale target at -1 dBTP", .1, 0, -1, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			// A full-scale stereo 1 kHz tone reads 0 LUFS, so a target of T LUFS
			// needs a peak of about T dBFS.
			input := normalizeTone(48000, test.amplitude)
			normalizer, err := NewNormalizer(fixture(t, input, input), ops.Range{End: 48000, ChannelMask: 3}, protocol.OperationNormalizeLoudness, test.target, Limits{})
			if err != nil {
				t.Fatal(err)
			}
			if err := normalizer.LimitTruePeak(test.ceiling); err != nil {
				t.Fatal(err)
			}
			result := finishNormalizer(t, normalizer)
			status := normalizer.Status()
			if status.CeilingLimited != test.limited || status.TruePeak == nil || status.PredictedLUFS == nil || status.OutputLUFS == nil {
				t.Fatalf("status %+v", status)
			}
			ceiling := math.Pow(10, test.ceiling/20)
			if *status.TruePeak > ceiling {
				t.Fatalf("true peak %g exceeds ceiling %g", *status.TruePeak, ceiling)
			}
			actual := measureNormalized(t, result, 3)
			if math.Abs(actual-*status.OutputLUFS) > .01 || math.Abs(actual-*status.PredictedLUFS) > .01 {
				t.Fatalf("rendered %g LUFS, output %g, predicted %g", actual, *status.OutputLUFS, *status.PredictedLUFS)
			}
			if test.limited {
				if *status.TruePeak < ceiling*(1-1e-6) || actual >= test.target-.01 {
					t.Fatalf("limited candidate true peak %g (ceiling %g), loudness %g (target %g)", *status.TruePeak, ceiling, actual, test.target)
				}
			} else if math.Abs(actual-test.target) > .01 {
				t.Fatalf("unlimited loudness %g, want %g", actual, test.target)
			}
		})
	}
}

func TestNormalizeTruePeakCeilingRejectsInvalidUse(t *testing.T) {
	input := quarterRateTone(48000, .1)
	newNormalizer := func(operation protocol.OperationName) *Normalizer {
		t.Helper()
		normalizer, err := NewNormalizer(fixture(t, input), ops.Range{End: 48000, ChannelMask: 1}, operation, -1, Limits{})
		if err != nil {
			t.Fatal(err)
		}
		return normalizer
	}
	if err := newNormalizer(protocol.OperationNormalizePeak).LimitTruePeak(-1); err == nil {
		t.Fatal("peak normalization accepted a true-peak ceiling")
	}
	for _, ceiling := range []float64{math.NaN(), math.Inf(-1), .1, -60.5} {
		if err := newNormalizer(protocol.OperationNormalizeLoudness).LimitTruePeak(ceiling); err == nil {
			t.Fatalf("ceiling %g accepted", ceiling)
		}
	}
	started := newNormalizer(protocol.OperationNormalizeLoudness)
	if _, err := started.Step(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := started.LimitTruePeak(-1); err == nil {
		t.Fatal("ceiling accepted after analysis started")
	}
}

func TestNormalizePeakCancelledWhileCopyingForTruePeak(t *testing.T) {
	input := quarterRateTone(4800, .1)
	normalizer, err := NewNormalizer(fixture(t, input), ops.Range{End: 4800, ChannelMask: 1}, protocol.OperationNormalizePeak, -1, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	// Step and the sample-peak scan pass; the true-peak copy sees the cancellation.
	if _, err := normalizer.Step(&operationCancelBoundary{remaining: 3}); !errors.Is(err, context.Canceled) {
		t.Fatalf("Step = %v, want cancellation", err)
	}
	if _, err := normalizer.Result(); err == nil || normalizer.Status().TruePeak != nil {
		t.Fatal("a cancelled analysis produced a result or a true peak")
	}
}
