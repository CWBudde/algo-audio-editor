package process_test

import (
	"errors"
	"math"
	"testing"

	"github.com/cwbudde/algo-dsp/measure/loudness"
)

// Exercise the released dependency in the kernel's actual float32 format,
// natively and under test-go-wasm. This is not editor Normalize integration.
// The dyadic fixture and expected result were derived offline using independent
// ECMAScript direct-form-I BS.1770-5 filters, prefix-summed complete 400 ms
// windows and separate absolute/relative gates. No production helper computes
// the expected value at test runtime.
func TestTaggedLoudnessFloat32GoldenAndLinkedNormalization(t *testing.T) {
	const frames = 57600
	input := make([][]float32, 2)
	planar := make([][]float64, 2)
	for channel := range input {
		input[channel] = make([]float32, frames)
		planar[channel] = make([]float64, frames)
		for frame := range frames {
			amplitude := 1.0
			if frame >= 38400 {
				amplitude = 2
			} else if frame >= 19200 {
				amplitude = 1.0 / 16384
			}

			value := float64(frame%31-15) / 128 * amplitude
			if channel == 1 {
				value = float64(frame%17-8) / 64 * amplitude
			}

			input[channel][frame] = float32(value)
			planar[channel][frame] = value
		}
	}

	config := loudness.IntegratedConfig{SampleRate: 48000, Channels: 2, MaxFrames: frames}
	analyzer, err := loudness.NewIntegratedAnalyzer(config)
	if err != nil {
		t.Fatal(err)
	}

	for start := 0; start < frames; start += 997 {
		end := min(start+997, frames)
		if err := analyzer.ProcessPlanar32([][]float32{input[0][start:end], input[1][start:end]}); err != nil {
			t.Fatal(err)
		}
	}

	for {
		done, err := analyzer.FinishStep(1)
		if err != nil {
			t.Fatal(err)
		}

		if done {
			break
		}
	}

	measured, err := analyzer.Result()
	if err != nil {
		t.Fatal(err)
	}

	if math.Abs(measured.LUFS-(-14.97089790733494)) > 1e-9 || measured.SamplePeak != 0.25 || measured.Frames != frames {
		t.Fatalf("tagged float32 measurement: %+v", measured)
	}

	plan, err := loudness.PlanNormalization(measured, -23)
	if err != nil {
		t.Fatal(err)
	}

	if math.Abs(plan.GainDB-(-8.02910209266506)) > 1e-9 || math.Abs(plan.Gain-0.3967755436430757) > 1e-10 {
		t.Fatalf("tagged linked gain: %+v", plan)
	}

	output, err := loudness.NormalizeLoudness(planar, -23, config)
	if err != nil {
		t.Fatal(err)
	}

	for _, golden := range []struct {
		channel, frame int
		value          float64
	}{
		{0, 0, -0.04649713402067294},
		{1, 0, -0.049596942955384464},
		{0, 38400, 0.043397325085961405},
		{1, 57599, -0.06199617869423058},
	} {
		if got := output[golden.channel][golden.frame]; math.Abs(got-golden.value) > 1e-10 {
			t.Fatalf("output channel %d frame %d: %.17g, want %.17g", golden.channel, golden.frame, got, golden.value)
		}
	}

	for channel := range output {
		if &output[channel][0] == &planar[channel][0] {
			t.Fatal("normalization result aliases its source")
		}

		for frame, value := range planar[channel] {
			if value != float64(input[channel][frame]) {
				t.Fatalf("normalization mutated channel %d frame %d", channel, frame)
			}
		}
	}

	analyzer.Reset()
	if err := analyzer.ProcessPlanar32([][]float32{make([]float32, 19200), make([]float32, 19200)}); err != nil {
		t.Fatal(err)
	}

	if _, err := analyzer.FinishStep(1); !errors.Is(err, loudness.ErrBelowGate) {
		t.Fatalf("silent selection must not fabricate a LUFS result: %v", err)
	}
}
