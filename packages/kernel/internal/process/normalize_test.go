package process

import (
	"context"
	"errors"
	"fmt"
	"math"
	"math/bits"
	"reflect"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	"github.com/cwbudde/algo-dsp/measure/loudness"
)

func finishNormalizer(t testing.TB, normalizer *Normalizer) audiobuf.Document {
	t.Helper()
	for attempts := 0; attempts < 50000; attempts++ {
		before := normalizer.Status()
		previous := normalizer.progress.FramesDone
		progress, err := normalizer.Step(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		status := normalizer.Status()
		if status.PhaseIndex < before.PhaseIndex || status.PhaseIndex >= status.PhaseCount || progress.FramesDone > progress.FramesTotal {
			t.Fatalf("invalid phase/progress: %+v %+v", status, progress)
		}
		if status.PhaseIndex == before.PhaseIndex && progress.FramesDone < previous {
			t.Fatal("progress moved backward within a phase")
		}
		if progress.Done {
			result, err := normalizer.Result()
			if err != nil {
				t.Fatal(err)
			}
			return result
		}
	}
	t.Fatal("normalizer failed to reach a bounded terminal result")
	return audiobuf.Document{}
}

func normalizeTone(frames int, amplitude float64) []float32 {
	signal := make([]float32, frames)
	for i := range signal {
		signal[i] = float32(amplitude * math.Sin(2*math.Pi*1000*float64(i)/48000))
	}
	return signal
}

func TestNormalizePeakStaticIEEEAndUnselectedSpecials(t *testing.T) {
	input := valuesFromBits([]uint32{0xc0000000, 0xbf800000, 0x80000000, 0, 0x3e800000, 0x3f000000, 0x3f800000, 0x40000000})
	other := valuesFromBits([]uint32{0x7f812345, 0xffc54321, 0x80000000, 1, 0x7f800000, 0xff800000, 0, 0x7f7fffff})
	document := fixture(t, input, other)
	normalizer, err := NewNormalizer(document, ops.Range{End: 8, ChannelMask: 1}, "normalize-peak", 0, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	result := finishNormalizer(t, normalizer)
	assertBits(t, samples(t, result, 0), valuesFromBits([]uint32{0xbf800000, 0xbf000000, 0x80000000, 0, 0x3e000000, 0x3e800000, 0x3f000000, 0x3f800000}))
	assertBits(t, samples(t, result, 1), other)
	assertBits(t, samples(t, document, 0), input)
	if !reflect.DeepEqual(result.Metadata(), document.Metadata()) || result.Frames() != document.Frames() {
		t.Fatal("normalization changed source metadata or length")
	}
	status := normalizer.Status()
	peak, nonfinite := normalizer.Peak()
	if status.InputPeak != 2 || !status.GainResolved || status.PhaseIndex != 1 || status.PhaseCount != 2 || peak != 1 || nonfinite || normalizer.Identity() {
		t.Fatalf("invalid linked normalization telemetry: %+v peak=%g/%t", status, peak, nonfinite)
	}
}

func TestNormalizePeakFiniteExtremeAndLinkedEightChannels(t *testing.T) {
	t.Run("subnormal needs more than UI sixty dB", func(t *testing.T) {
		input := valuesFromBits([]uint32{1, 2, 0x80000000})
		normalizer, err := NewNormalizer(fixture(t, input), ops.Range{End: 3, ChannelMask: 1}, "normalize-peak", 0, Limits{})
		if err != nil {
			t.Fatal(err)
		}
		assertBits(t, samples(t, finishNormalizer(t, normalizer), 0), valuesFromBits([]uint32{0x3f000000, 0x3f800000, 0x80000000}))
		if normalizer.Status().GainDB < 800 {
			t.Fatal("extreme finite normalization gain was clamped")
		}
	})
	t.Run("maximum finite input needs more than UI minus one twenty dB", func(t *testing.T) {
		input := []float32{math.MaxFloat32, -math.MaxFloat32, math.Float32frombits(0x80000000)}
		normalizer, err := NewNormalizer(fixture(t, input), ops.Range{End: 3, ChannelMask: 1}, "normalize-peak", 0, Limits{})
		if err != nil {
			t.Fatal(err)
		}
		assertBits(t, samples(t, finishNormalizer(t, normalizer), 0), []float32{1, -1, math.Float32frombits(0x80000000)})
		if normalizer.Status().GainDB > -700 {
			t.Fatal("large finite attenuation was clamped")
		}
	})
	t.Run("minimum target is accepted without clipping headroom", func(t *testing.T) {
		normalizer, err := NewNormalizer(fixture(t, []float32{2, -1}), ops.Range{End: 2, ChannelMask: 1}, "normalize-peak", -120, Limits{})
		if err != nil {
			t.Fatal(err)
		}
		assertBits(t, samples(t, finishNormalizer(t, normalizer), 0), []float32{1e-6, -5e-7})
	})
	t.Run("eight channel linking preserves subset", func(t *testing.T) {
		input := make([][]float32, 8)
		for i := range input {
			input[i] = []float32{float32(i + 1), float32(-i - 1)}
		}
		document := fixture(t, input...)
		normalizer, err := NewNormalizer(document, ops.Range{End: 2, ChannelMask: 129}, "normalize-peak", 0, Limits{})
		if err != nil {
			t.Fatal(err)
		}
		result := finishNormalizer(t, normalizer)
		for i := range input {
			want := input[i]
			switch i {
			case 0:
				want = []float32{0.125, -0.125}
			case 7:
				want = []float32{1, -1}
			}
			assertBits(t, samples(t, result, i), want)
		}
	})
}

func TestLinearGainResolvedCoefficientValidationAndIdentity(t *testing.T) {
	for _, factor := range []float64{0, -1, math.NaN(), math.Inf(1), math.Inf(-1)} {
		if _, err := (LinearGain{Factor: factor}).NewChannel(48000, 0, 1); err == nil {
			t.Fatalf("invalid resolved factor %g accepted", factor)
		}
	}
	for _, factor := range []float64{math.SmallestNonzeroFloat64, 1, math.MaxFloat64} {
		if _, err := (LinearGain{Factor: factor}).NewChannel(48000, 0, 1); err != nil {
			t.Fatalf("finite positive resolved factor %g rejected: %v", factor, err)
		}
	}
	if !identityProcess(LinearGain{Factor: 1}) || !identityProcess(&LinearGain{Factor: 1}) || identityProcess((*LinearGain)(nil)) || identityProcess(LinearGain{Factor: 2}) {
		t.Fatal("resolved gain identity classification is incorrect")
	}
}

func TestNormalizeOutputStartsOnlyAfterAnalysisAndHonorsBudget(t *testing.T) {
	frames := audiobuf.BlockFrames + 17
	input := normalizeTone(frames, 0.5)
	document := fixture(t, input)
	normalizer, err := NewNormalizer(document, ops.Range{End: int64(frames), ChannelMask: 1}, "normalize-peak", 0, Limits{MaxOutputBytes: 1})
	if err != nil {
		t.Fatal("output budget should not allocate/reject before analysis", err)
	}
	for range 2 {
		if _, err := normalizer.Step(context.Background()); err != nil {
			t.Fatal(err)
		}
		memory, err := normalizer.MemoryDocument()
		if err != nil || audiobuf.CountMemory(memory).SampleBytes != 0 || normalizer.builder != nil {
			t.Fatalf("analysis materialized output: %v %v", memory, err)
		}
	}
	if _, err := normalizer.Step(context.Background()); err == nil {
		t.Fatal("resolved nonidentity output bypassed budget")
	}
	if _, err := normalizer.Result(); err == nil || normalizer.storage != nil || normalizer.builder != nil {
		t.Fatal("failed planning retained output/scratch/result")
	}
	assertBits(t, samples(t, document, 0), input)
}

func TestNormalizeSilenceIdentityAndShortLoudness(t *testing.T) {
	for _, operation := range []string{"normalize-peak", "normalize-loudness"} {
		t.Run(operation, func(t *testing.T) {
			input := make([]float32, 19200)
			input[23] = math.Float32frombits(0x80000000)
			document := fixture(t, input)
			normalizer, err := NewNormalizer(document, ops.Range{End: 19200, ChannelMask: 1}, operation, -23, Limits{MaxOutputBytes: 1})
			if err != nil {
				t.Fatal(err)
			}
			result := finishNormalizer(t, normalizer)
			assertBits(t, samples(t, result, 0), input)
			if !normalizer.Identity() || normalizer.Status().UnchangedReason != "silent" || normalizer.Status().InputLUFS != nil || normalizer.Status().OutputLUFS != nil || normalizer.Status().PredictedLUFS != nil {
				t.Fatalf("silent source fabricated loudness or output: %+v", normalizer.Status())
			}
			if got, want := audiobuf.CountMemoryWithWindows([]audiobuf.Document{document, result}), audiobuf.CountMemory(document); got.SampleBytes != want.SampleBytes || got.PeakBytes != want.PeakBytes {
				t.Fatal("silent identity duplicated retained audio")
			}
		})
	}
	normalizer, err := NewNormalizer(fixture(t, make([]float32, 19199)), ops.Range{End: 19199, ChannelMask: 1}, "normalize-loudness", -23, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := normalizer.Step(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := normalizer.Step(context.Background()); !errors.Is(err, loudness.ErrTooShort) {
		t.Fatalf("short silent LUFS selection=%v, want ErrTooShort", err)
	}
}

func TestNormalizeRejectsSelectedNonfiniteAndCancelEveryPhase(t *testing.T) {
	for _, value := range []float32{float32(math.NaN()), float32(math.Inf(1)), float32(math.Inf(-1))} {
		document := fixture(t, []float32{0.5, value})
		normalizer, err := NewNormalizer(document, ops.Range{End: 2, ChannelMask: 1}, "normalize-peak", 0, Limits{})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := normalizer.Step(context.Background()); !errors.Is(err, loudness.ErrNonFinite) {
			t.Fatalf("selected nonfinite accepted: %v", err)
		}
		if normalizer.storage != nil || normalizer.builder != nil || normalizer.status.GainResolved {
			t.Fatal("invalid selected audio retained scratch or resolved gain")
		}
	}
	for _, phase := range []string{"analyzing", "processing", "verifying"} {
		t.Run(phase, func(t *testing.T) {
			input := normalizeTone(19200, 0.5)
			document := fixture(t, input)
			normalizer, err := NewNormalizer(document, ops.Range{End: 19200, ChannelMask: 1}, "normalize-loudness", -23, Limits{})
			if err != nil {
				t.Fatal(err)
			}
			for attempts := 0; normalizer.Status().Phase != phase && attempts < 1000; attempts++ {
				if _, err := normalizer.Step(context.Background()); err != nil {
					t.Fatal(err)
				}
			}
			if normalizer.Status().Phase != phase {
				t.Fatal("requested cancellation phase not reached")
			}
			normalizer.Cancel()
			if _, err := normalizer.Result(); !errors.Is(err, context.Canceled) {
				t.Fatalf("cancel left valid candidate: %v", err)
			}
			if normalizer.storage != nil || normalizer.channels != nil || normalizer.builder != nil || normalizer.analyzer != nil || normalizer.verification != nil {
				t.Fatal("cancellation retained private workspace")
			}
			assertBits(t, samples(t, document, 0), input)
		})
	}
}

func TestNormalizeLoudnessLinkedProgramAndBelowGate(t *testing.T) {
	for _, amplitude := range []float64{0.5, 1e-5} {
		input := normalizeTone(48000, amplitude)
		normalizer, err := NewNormalizer(fixture(t, input, input), ops.Range{End: 48000, ChannelMask: 3}, "normalize-loudness", -23, Limits{})
		if err != nil {
			t.Fatal(err)
		}
		result := finishNormalizer(t, normalizer)
		assertBits(t, samples(t, result, 0), samples(t, result, 1))
		status := normalizer.Status()
		if !status.GainResolved || status.PredictedLUFS == nil || math.Abs(*status.PredictedLUFS+23) > 0.01 || status.PhaseIndex != 2 || status.PhaseCount != 3 {
			t.Fatalf("invalid loudness plan: %+v", status)
		}
		if amplitude == 1e-5 && status.InputLUFS != nil {
			t.Fatal("below-gate source invented measured LUFS")
		}
		if normalizer.verifyInput && (status.OutputLUFS == nil || math.Abs(*status.OutputLUFS+23) > 0.01) {
			t.Fatal("required stored float32 verification was not completed")
		}
		actual := measureNormalized(t, result, 3)
		if math.Abs(actual+23) > 0.01 {
			t.Fatalf("rendered loudness=%g, want -23", actual)
		}
	}
}

func TestNormalizeLoudnessIndependentFilterGateGolden(t *testing.T) {
	const frames = 57600
	input := make([][]float32, 2)
	for channel := range input {
		input[channel] = make([]float32, frames)
		for frame := range frames {
			amplitude := 1.0
			if frame >= 38400 {
				amplitude = 2
			} else if frame >= 19200 {
				amplitude = .0001
			}
			value := float64(frame%31-15) / 128
			if channel == 1 {
				value = float64(frame%17-8) / 64
			}
			input[channel][frame] = float32(value * amplitude)
		}
	}
	normalizer, err := NewNormalizer(fixture(t, input...), ops.Range{End: frames, ChannelMask: 3}, "normalize-loudness", -23, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	result := finishNormalizer(t, normalizer)
	// Independent direct-form-I/prefix-window oracle checked into upstream's
	// conformance tests. The intervening near-silent window is gated out. The
	// tolerance accommodates conversion of that segment to stored float32.
	const goldenLUFS = -14.970897903199129
	status := normalizer.Status()
	if status.InputLUFS == nil || math.Abs(*status.InputLUFS-goldenLUFS) > 1e-6 || math.Abs(status.GainDB-(-23-goldenLUFS)) > 1e-6 || status.InputPeak != .25 {
		t.Fatalf("linked source/gain differs from independent golden: %+v", status)
	}
	if math.Abs(measureNormalized(t, result, 3)+23) > .01 {
		t.Fatal("stored normalized golden did not reach target")
	}
}

func TestNormalizeLoudnessImmutableCertificationCopiedPlanAndActualCandidateParity(t *testing.T) {
	const frames = audiobuf.BlockFrames + 17000
	for _, amplitude := range []float64{0.5, 1e-5, 1e30, math.SmallestNonzeroFloat32} {
		t.Run(fmt.Sprintf("amplitude%g", amplitude), func(t *testing.T) {
			left, right := normalizeTone(frames, amplitude), normalizeTone(frames, amplitude*.75)
			untouched := make([]float32, frames)
			for i := range untouched {
				untouched[i] = math.Float32frombits(0x7f812345)
			}
			document := fixture(t, left, untouched, right)
			selected := ops.Range{Start: 13, End: frames - 17, ChannelMask: 5}
			reference, err := loudness.NewTargetAnalyzer(loudness.IntegratedConfig{SampleRate: 48000, Channels: 2, MaxFrames: selected.End - selected.Start}, -23)
			if err != nil {
				t.Fatal(err)
			}
			for start := selected.Start; start < selected.End; {
				end := min(start+997, selected.End)
				if err := reference.ProcessPlanar32([][]float32{left[start:end], right[start:end]}); err != nil {
					t.Fatal(err)
				}
				start = end
			}
			for {
				done, err := reference.FinishStep(19)
				if err != nil {
					t.Fatal(err)
				}
				if done {
					break
				}
			}
			plan, err := reference.Result()
			if err != nil {
				t.Fatal(err)
			}
			normalizer, err := NewNormalizer(document, selected, "normalize-loudness", -23, Limits{})
			if err != nil {
				t.Fatal(err)
			}
			candidate := finishNormalizer(t, normalizer)
			status := normalizer.Status()
			if status.GainDB != plan.Plan.GainDB || (status.InputLUFS != nil) != plan.HasMeasuredLUFS || (status.InputLUFS != nil && *status.InputLUFS != plan.MeasuredLUFS) {
				t.Fatalf("immutable certification changed copied reference plan: %+v/%+v", status, plan)
			}
			for channel, input := range map[int][]float32{0: left, 2: right} {
				got := samples(t, candidate, channel)
				for frame, value := range input {
					want := value
					if int64(frame) >= selected.Start && int64(frame) < selected.End {
						want = float32(float64(value) * plan.Plan.Gain)
					}
					if math.Float32bits(got[frame]) != math.Float32bits(want) {
						t.Fatalf("candidate channel%d frame%d differs from copied reference", channel, frame)
					}
				}
				assertBits(t, samples(t, document, channel), input)
			}
			assertBits(t, samples(t, candidate, 1), untouched)
			selectedChannels := make([]audiobuf.Channel, 0, 2)
			for _, index := range []int{0, 2} {
				channel, _ := candidate.Channel(index)
				part, err := channel.Slice(selected.Start, selected.End)
				if err != nil {
					t.Fatal(err)
				}
				selectedChannels = append(selectedChannels, part)
			}
			actualDocument, err := audiobuf.NewDocument(selectedChannels, 48000, audiobuf.Metadata{})
			if err != nil {
				t.Fatal(err)
			}
			actual := measureNormalized(t, actualDocument, 3)
			if status.OutputLUFS == nil || math.Abs(*status.OutputLUFS-actual) > 1e-10 || math.Abs(actual+23) > .01 {
				t.Fatalf("certified stored candidate differs from ordinary actual meter: %+v/%g", status, actual)
			}
		})
	}
}

func measureNormalized(t testing.TB, document audiobuf.Document, mask int) float64 {
	t.Helper()
	count := bits.OnesCount(uint(mask))
	analyzer, err := loudness.NewIntegratedAnalyzer(loudness.IntegratedConfig{SampleRate: float64(document.SampleRate()), Channels: count, MaxFrames: document.Frames()})
	if err != nil {
		t.Fatal(err)
	}
	block := make([][]float32, 0, count)
	for channel := range document.Channels() {
		if mask&(1<<channel) != 0 {
			block = append(block, samples(t, document, channel))
		}
	}
	views := make([][]float32, count)
	for start := 0; int64(start) < document.Frames(); {
		end := min(start+audiobuf.BlockFrames, int(document.Frames()))
		for channel := range views {
			views[channel] = block[channel][start:end]
		}
		if err := analyzer.ProcessPlanar32(views); err != nil {
			t.Fatal(err)
		}
		start = end
	}
	for {
		done, err := analyzer.FinishStep(1)
		if err != nil {
			t.Fatal(err)
		}
		if done {
			result, err := analyzer.Result()
			if err != nil {
				t.Fatal(err)
			}
			return result.LUFS
		}
	}
}
