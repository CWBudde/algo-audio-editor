package engine

import (
	"math"
	"slices"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
	"github.com/cwbudde/algo-dsp/dsp/resample"
)

func referenceRateGCD(a, b int) int {
	for b != 0 {
		a, b = b, a%b
	}
	return a
}

func directResampled(t *testing.T, input []float32, inRate, outRate, outputs int) []float32 {
	t.Helper()
	g := referenceRateGCD(inRate, outRate)
	up, down := outRate/g, inRate/g
	taps := resample.QualityProfile(resample.QualityBalanced).TapsPerPhase * ((down + up - 1) / up)
	stream, err := resample.NewRational(up, down, resample.WithTapsPerPhase(taps))
	if err != nil {
		t.Fatal(err)
	}
	skip := int(math.Ceil(stream.GroupDelayOutput()))
	// A generous explicit zero extension gives the independent one-shot codec
	// reference enough output for both delay compensation and the final impulse.
	work := make([]float64, len(input)+taps+inRate/outRate+2)
	for i, sample := range input {
		work[i] = float64(sample)
	}
	all := stream.Process(work)
	if len(all) < skip+outputs {
		t.Fatalf("reference produced %d, need %d", len(all), skip+outputs)
	}
	out := make([]float32, outputs)
	for i := range out {
		out[i] = float32(all[skip+i])
	}
	return out
}

func TestTransportResampleDurationReferenceAndChunkParity(t *testing.T) {
	for _, rates := range [][2]int{{44100, 48000}, {48000, 44100}, {48000, 96000}, {96000, 48000}, {384000, 8000}, {8000, 384000}} {
		inRate, outRate := rates[0], rates[1]
		for _, frames := range []int{1, 7, 2111} {
			samples := make([]float32, frames*2)
			for i := range frames {
				samples[i*2] = float32(math.Sin(float64(i) * 0.07))
				samples[i*2+1] = float32(math.Cos(float64(i) * 0.13))
			}
			outputs := (frames*outRate + inRate - 1) / inRate
			whole := transportEngine(t, samples, 2, inRate, outRate)
			playRange(t, whole, 0, int64(frames), false)
			want, wantTags := make([]float32, outputs*2), make([]int64, outputs)
			if n := whole.RenderWithPositions(want, wantTags); n != outputs {
				t.Fatalf("%d->%d %d frames rendered %d of %d", inRate, outRate, frames, n, outputs)
			}
			if whole.Render(make([]float32, 16)) != 0 || whole.playback.transport.position != int64(frames) || whole.playback.transport.playing {
				t.Fatal("resampled EOF state incorrect")
			}
			for i, position := range wantTags {
				expected := int64(min(frames, (i+1)*inRate/outRate))
				if i == outputs-1 {
					expected = int64(frames)
				}
				if position != expected {
					t.Fatalf("%d->%d tag[%d]=%d, want %d", inRate, outRate, i, position, expected)
				}
			}
			for channel := range 2 {
				mono := make([]float32, frames)
				for i := range mono {
					mono[i] = samples[i*2+channel]
				}
				reference := directResampled(t, mono, inRate, outRate, outputs)
				for i, sample := range reference {
					if math.Float32bits(sample) != math.Float32bits(want[i*2+channel]) {
						t.Fatalf("%d->%d frames=%d channel=%d output=%d differs from DSP reference: %v vs %v", inRate, outRate, frames, channel, i, want[i*2+channel], sample)
					}
				}
			}
			for _, size := range []int{1, 7, 127, 4096} {
				chunked := transportEngine(t, samples, 2, inRate, outRate)
				playRange(t, chunked, 0, int64(frames), false)
				got, gotTags := make([]float32, 0, len(want)), make([]int64, 0, outputs)
				buffer, tags := make([]float32, size*2), make([]int64, size)
				for {
					n := chunked.RenderWithPositions(buffer, tags)
					got = append(got, buffer[:n*2]...)
					gotTags = append(gotTags, tags[:n]...)
					if n < size {
						for _, sample := range buffer[n*2:] {
							if sample != 0 {
								t.Fatal("resampled short render left an audible stale tail")
							}
						}
						break
					}
				}
				if !slices.Equal(got, want) || !slices.Equal(gotTags, wantTags) {
					t.Fatalf("%d->%d frames=%d chunk=%d changed samples or tags", inRate, outRate, frames, size)
				}
			}
		}
	}
}

func TestTransportResampleDelayAndFinalImpulse(t *testing.T) {
	const frames = 512
	for _, impulse := range []int{0, 100, frames - 1} {
		samples := make([]float32, frames)
		samples[impulse] = 1
		e := transportEngine(t, samples, 1, 48000, 44100)
		playRange(t, e, 0, frames, false)
		count := (frames*44100 + 48000 - 1) / 48000
		output, positions := make([]float32, count), make([]int64, count)
		if n := e.RenderWithPositions(output, positions); n != count {
			t.Fatalf("impulse render count %d, want %d", n, count)
		}
		peak := 0
		for i := range output {
			if math.Abs(float64(output[i])) > math.Abs(float64(output[peak])) {
				peak = i
			}
		}
		if math.Abs(float64(peak)-float64(impulse)*44100/48000) > 1 {
			t.Fatalf("delay was not removed: input impulse %d peaked at output %d", impulse, peak)
		}
		if math.Abs(float64(positions[peak]-int64(impulse))) > 2 || output[peak] == 0 {
			t.Fatalf("audible impulse and tag disagree: impulse=%d output=%d tag=%d", impulse, peak, positions[peak])
		}
		if impulse == frames-1 && output[len(output)-1] == 0 {
			t.Fatal("final impulse was lost instead of flushing delayed audio")
		}
	}
}

func TestTransportResampleLoopContinuityAndSeek(t *testing.T) {
	const inputRate, outputRate = 48000, 44100
	samples := make([]float32, 79)
	for i := range samples {
		samples[i] = float32(math.Sin(float64(i) * 0.19))
	}
	e := transportEngine(t, samples, 1, inputRate, outputRate)
	playRange(t, e, 3, 61, true)
	for _, initial := range []int64{3, 15} {
		if initial != 3 {
			if _, err := e.seekDocument(protocol.TransportSeekParams{Frame: initial}); err != nil {
				t.Fatal(err)
			}
		}
		const outputs = 7000
		periodic := make([]float32, (outputs+100)*inputRate/outputRate+100)
		for i := range periodic {
			periodic[i] = samples[3+(int(initial)-3+i)%58]
		}
		want := directResampled(t, periodic, inputRate, outputRate, outputs)
		got, tags := make([]float32, outputs), make([]int64, outputs)
		for start := 0; start < outputs; start += 127 {
			end := min(start+127, outputs)
			if n := e.RenderWithPositions(got[start:end], tags[start:end]); n != end-start {
				t.Fatalf("loop short render %d", n)
			}
		}
		if !slices.Equal(got, want) {
			t.Fatal("loop reset FIR history or changed sample continuity")
		}
		for i, tag := range tags {
			position := int64(3 + (int(initial)-3+(i+1)*inputRate/outputRate)%58)
			if tag != position {
				t.Fatalf("loop tag[%d]=%d, want %d", i, tag, position)
			}
		}
	}
}

func TestTransportExtremeDownsampleAntiAlias(t *testing.T) {
	const sourceRate, outputRate, frames = 384000, 8000, 38400
	levels := make([]float64, 0, 2)
	for _, frequency := range []float64{1000, 6000} {
		samples := make([]float32, frames)
		for i := range samples {
			samples[i] = float32(math.Sin(2 * math.Pi * frequency * float64(i) / sourceRate))
		}
		e := transportEngine(t, samples, 1, sourceRate, outputRate)
		playRange(t, e, 0, frames, false)
		output := make([]float32, frames*outputRate/sourceRate)
		if e.Render(output) != len(output) {
			t.Fatal("anti-alias test ended early")
		}
		var energy float64
		for _, sample := range output[128 : len(output)-128] {
			energy += float64(sample) * float64(sample)
		}
		levels = append(levels, math.Sqrt(energy/float64(len(output)-256)))
	}
	if levels[0] < 0.70 || levels[0] > 0.72 {
		t.Fatalf("1kHz passband amplitude %v", levels[0])
	}
	if attenuation := 20 * math.Log10(levels[1]/levels[0]); attenuation > -60 {
		t.Fatalf("6kHz alias attenuation %v dB, need at least60dB", attenuation)
	}
}

func TestTransportResampleWorkspaceFailureIsAtomic(t *testing.T) {
	e := transportEngine(t, []float32{0, 1, 0}, 1, 383999, 384000)
	if _, err := e.playDocument(protocol.TransportPlayParams{}); err == nil || e.playback.transport != nil || e.playback.source != sourceStopped {
		t.Fatalf("unbounded exact-ratio workspace accepted or changed state: %v", err)
	}
}

func TestConvertedFrameCountAvoidsLongRunOverflow(t *testing.T) {
	frames := int64(1<<53 - 1)
	if got, err := resample.FrameCount(frames, 8000, 384000); err != nil || got != frames*48 {
		t.Fatalf("long duration %d, want %d", got, frames*48)
	}
	if got, err := resample.FrameCount(frames, 384000, 8000); err != nil || got != (frames+47)/48 {
		t.Fatalf("long duration %d, want %d", got, (frames+47)/48)
	}
}

func TestTransportRenderAllocations(t *testing.T) {
	for _, rate := range []int{48000, 44100} {
		e := transportEngine(t, make([]float32, 2*8192), 2, 48000, rate)
		playRange(t, e, 0, 8192, true)
		output, tags := make([]float32, 128*2), make([]int64, 128)
		if allocations := testing.AllocsPerRun(100, func() { e.RenderWithPositions(output, tags) }); allocations != 0 {
			t.Fatalf("render at %d Hz allocated %v times", rate, allocations)
		}
	}
}

func BenchmarkTransportRenderResampled(b *testing.B) {
	e := New()
	samples := make([]float64, 48000*2)
	for i := range samples {
		samples[i] = math.Sin(float64(i) * 0.07)
	}
	if _, err := e.openDocument(protocol.DocumentOpenParams{}, rawWAV(3, 32, 2, 48000, floatPayload(32, samples), false)); err != nil {
		b.Fatal(err)
	}
	if _, err := e.configure(protocol.EngineConfigureParams{SampleRate: 44100, Channels: 2}); err != nil {
		b.Fatal(err)
	}
	if _, err := e.playDocument(protocol.TransportPlayParams{Loop: true}); err != nil {
		b.Fatal(err)
	}
	output, tags := make([]float32, 128*2), make([]int64, 128)
	b.ReportAllocs()
	for b.Loop() {
		e.RenderWithPositions(output, tags)
	}
}
