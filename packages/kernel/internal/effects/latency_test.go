package effects

import (
	"math"
	"reflect"
	"strconv"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/process"
)

func TestAlgorithmicLatencyCompensatedShortPitchSelectionIsAudible(t *testing.T) {
	for _, effect := range []string{"pitch-time", "pitch-spectral"} {
		for _, frames := range []int{129, 1001, 48001} {
			t.Run(effect+"/"+strconv.Itoa(frames), func(t *testing.T) {
				samples := make([]float32, frames)
				for frame := range samples {
					samples[frame] = float32(.3 * math.Sin(2*math.Pi*220*float64(frame)/48000))
				}
				document, err := audiobuf.NewDocument([]audiobuf.Channel{audiobuf.NewChannel(samples)}, 48000, audiobuf.Metadata{})
				if err != nil {
					t.Fatal(err)
				}
				selected := ops.Range{Start: 0, End: int64(frames), ChannelMask: 1}
				config, err := NewConfig(document, selected, testGraph(effect, map[string]any{"semitones": 12.0}), 1, false, nil)
				if err != nil {
					t.Fatal(err)
				}
				stream, err := NewStream(document, selected, config)
				if err != nil {
					t.Fatal(err)
				}
				if err := stream.Prime(0); err != nil {
					t.Fatal(err)
				}
				output := collectStream(t, stream, 0, frames, 17, 1)[0]
				peak := 0.0
				for _, sample := range output {
					peak = math.Max(peak, math.Abs(sample))
				}
				if peak < .001 {
					t.Fatalf("short actual +12 pitch output is silence, peak=%g", peak)
				}
				job, err := NewJob(document, selected, config, process.Limits{})
				if err != nil {
					t.Fatal(err)
				}
				candidate := finishJob(t, job)
				channel, _ := candidate.Channel(0)
				offline := make([]float64, frames)
				channel.ReadFloat64(offline, 0)
				if !reflect.DeepEqual(output, offline) {
					t.Fatal("short compensated preview differs from actual offline candidate")
				}
				if frames >= 48000 {
					start, end := frames/4, frames*3/4
					crossings := 0
					for frame := start + 1; frame < end; frame++ {
						if output[frame-1] <= 0 && output[frame] > 0 {
							crossings++
						}
					}
					frequency := float64(crossings) * 48000 / float64(end-start)
					if math.Abs(frequency-440) > 6 {
						t.Fatalf("independent octave frequency got%gHz want440Hz", frequency)
					}
				}
			})
		}
	}
}

func TestStereoWidenerUsesActualChannelPairAndConvolutionRecoversAlignedTail(t *testing.T) {
	document := testDocument(t, 257, 2)
	selected := ops.Range{Start: 0, End: 257, ChannelMask: 3}
	config, err := NewConfig(document, selected, testGraph("widener", map[string]any{"width": 0.0, "mix": 1.0}), 1, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	stream, err := NewStream(document, selected, config)
	if err != nil {
		t.Fatal(err)
	}
	output := collectStream(t, stream, 0, 257, 31, 2)
	left, right := make([]float64, 257), make([]float64, 257)
	a, _ := document.Channel(0)
	b, _ := document.Channel(1)
	a.ReadFloat64(left, 0)
	b.ReadFloat64(right, 0)
	for frame := range left {
		want := float64(float32((left[frame] + right[frame]) / 2))
		if output[0][frame] != want || output[1][frame] != want {
			t.Fatalf("stereo pair was processed as independent mono at%d", frame)
		}
	}
	impulseL, impulseR := make([]float32, 257), make([]float32, 257)
	impulseL[254] = 1
	impulseR[252] = .5
	document, err = audiobuf.NewDocument([]audiobuf.Channel{audiobuf.NewChannel(impulseL), audiobuf.NewChannel(impulseR)}, 48000, audiobuf.Metadata{})
	if err != nil {
		t.Fatal(err)
	}
	config, err = NewConfig(document, selected, testGraph("reverb-conv", map[string]any{"irIndex": 1, "wet": 1.0}), 1, false, fixtureIR{})
	if err != nil {
		t.Fatal(err)
	}
	stream, err = NewStream(document, selected, config)
	if err != nil {
		t.Fatal(err)
	}
	output = collectStream(t, stream, 0, 257, 37, 2)
	for frame := range 257 {
		wantL, wantR := 0.0, 0.0
		if frame == 254 {
			wantL = 2 // The registry convolution runtime adds wet IR to unity dry.
			wantR = .125
		}
		if frame == 255 {
			wantL = .25
		}
		if frame == 252 {
			wantR = .75
		}
		if math.Abs(output[0][frame]-wantL) > 1e-7 || math.Abs(output[1][frame]-wantR) > 1e-7 {
			t.Fatalf("convolution aligned tail/channel mismatch frame%d got%g,%g want%g,%g", frame, output[0][frame], output[1][frame], wantL, wantR)
		}
	}
}

type channelMappedIR struct{ samples [][]float64 }

func (p channelMappedIR) GetIR(index int) ([][]float64, float64, bool) {
	return p.samples, 48000, index == 1
}

func TestConvolutionSelectionPreservesPhysicalStereoIRSide(t *testing.T) {
	const frames = 601
	channels := make([]audiobuf.Channel, 4)
	sources := make([][]float32, 4)
	for channel := range channels {
		sources[channel] = make([]float32, frames)
		for frame := range sources[channel] {
			sources[channel][frame] = math.Float32frombits(0x80000000)
		}
		sources[channel][29] = float32(channel+1) / 8
		sources[channel][2] = .375
		channels[channel] = audiobuf.NewChannel(sources[channel])
	}
	document, err := audiobuf.NewDocument(channels, 48000, audiobuf.Metadata{})
	if err != nil {
		t.Fatal(err)
	}
	impulse := [][]float64{make([]float64, 513), make([]float64, 513)}
	impulse[0][0], impulse[1][0] = .5, -.25
	impulse[0][128], impulse[1][128] = .125, .375
	for _, mask := range []int{2, 5, 15} {
		for _, irChannels := range []int{1, 2} {
			t.Run(strconv.Itoa(mask)+"/ir"+strconv.Itoa(irChannels), func(t *testing.T) {
				selected := ops.Range{Start: 7, End: 594, ChannelMask: mask}
				config, err := NewConfig(document, selected, testGraph("reverb-conv", map[string]any{"irIndex": 1, "wet": 1.0}), 1, false, channelMappedIR{samples: impulse[:irChannels]})
				if err != nil {
					t.Fatal(err)
				}
				stream, err := NewStream(document, selected, config)
				if err != nil {
					t.Fatal(err)
				}
				preview := collectStream(t, stream, selected.Start, int(selected.End-selected.Start), 17, 4)
				job, err := NewJob(document, selected, config, process.Limits{})
				if err != nil {
					t.Fatal(err)
				}
				candidate := finishJob(t, job)
				for channel := range channels {
					data, _ := candidate.Channel(channel)
					actual := make([]float32, frames)
					data.Read(actual, 0)
					amplitude := float64(sources[channel][29])
					selectedChannel := mask&(1<<channel) != 0
					first, tail := amplitude, 0.0
					if selectedChannel {
						first += amplitude * impulse[channel%irChannels][0]
						tail = amplitude * impulse[channel%irChannels][128]
					}
					if math.Abs(float64(actual[29])-first) > 1e-7 || math.Abs(float64(actual[157])-tail) > 1e-7 {
						t.Fatalf("physical channel%d mapped wrong IR: first%g tail%g want%g/%g", channel, actual[29], actual[157], first, tail)
					}
					for frame, sample := range actual {
						if frame < int(selected.Start) || frame >= int(selected.End) || !selectedChannel {
							if math.Float32bits(sample) != math.Float32bits(sources[channel][frame]) {
								t.Fatalf("unselected source bits changed channel%d frame%d", channel, frame)
							}
						}
						if frame >= int(selected.Start) && frame < int(selected.End) && math.Float32bits(sample) != math.Float32bits(float32(preview[channel][frame-int(selected.Start)])) {
							t.Fatalf("actual preview/offline mismatch channel%d frame%d", channel, frame)
						}
					}
				}
			})
		}
	}
}
