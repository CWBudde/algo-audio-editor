package effects

import (
	"context"
	"math"
	"reflect"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/process"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
	"github.com/cwbudde/algo-dsp/dsp/effectchain"
)

func testGraph(effect string, params map[string]any) protocol.EffectGraph {
	return protocol.EffectGraph{Nodes: []protocol.EffectNode{{ID: "_input", Type: "_input"}, {ID: "fx", Type: effect, Params: params}, {ID: "_output", Type: "_output"}}, Connections: []protocol.EffectConnection{{From: "_input", To: "fx"}, {From: "fx", To: "_output"}}}
}

func testDocument(t *testing.T, frames, channels int) audiobuf.Document {
	t.Helper()
	data := make([]audiobuf.Channel, channels)
	for channel := range channels {
		samples := make([]float32, frames)
		for frame := range frames {
			samples[frame] = float32(.2 * math.Sin(float64(frame)*.031+float64(channel)*.3))
		}
		data[channel] = audiobuf.NewChannel(samples)
	}
	document, err := audiobuf.NewDocument(data, 48000, audiobuf.Metadata{Name: "source", Tags: map[string]string{"test": "immutable"}})
	if err != nil {
		t.Fatal(err)
	}
	return document
}

func collectStream(t *testing.T, stream *Stream, start int64, count, partition, channels int) [][]float64 {
	t.Helper()
	output := make([][]float64, channels)
	scratch := make([][]float64, channels)
	for channel := range output {
		output[channel] = make([]float64, count)
		scratch[channel] = make([]float64, partition)
	}
	for cursor := 0; cursor < count; cursor += partition {
		n := min(partition, count-cursor)
		for channel := range scratch {
			scratch[channel] = scratch[channel][:n]
		}
		if err := stream.Read(scratch, start+int64(cursor)); err != nil {
			t.Fatal(err)
		}
		for channel := range output {
			copy(output[channel][cursor:cursor+n], scratch[channel])
		}
	}
	return output
}

func finishJob(t *testing.T, job *Job) audiobuf.Document {
	t.Helper()
	for !job.Progress().Done {
		if _, err := job.Step(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	result, err := job.Result()
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestRingModulatorAnalyticGoldenWetAndUnselectedSource(t *testing.T) {
	document := testDocument(t, 513, 3)
	selected := ops.Range{Start: 11, End: 502, ChannelMask: 5}
	config, err := NewConfig(document, selected, testGraph("ringmod", map[string]any{"carrierHz": 750.0, "mix": 1.0}), .25, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	stream, err := NewStream(document, selected, config)
	if err != nil {
		t.Fatal(err)
	}
	output := collectStream(t, stream, selected.Start, int(selected.End-selected.Start), 37, 3)
	for channel := range output {
		source, _ := document.Channel(channel)
		input := make([]float64, len(output[channel]))
		source.ReadFloat64(input, selected.Start)
		for frame, value := range output[channel] {
			want := input[frame]
			if channel != 1 {
				want *= .75 + .25*math.Sin(2*math.Pi*750*float64(frame)/48000)
			}
			if math.Abs(value-float64(float32(want))) > 2e-8 {
				t.Fatalf("channel%d frame%d got%.12g want%.12g", channel, frame, value, want)
			}
		}
	}
	meter := stream.Meters()
	if meter.Frames != selected.End-selected.Start || meter.InputPeak[1] != 0 || meter.OutputPeak[0] <= 0 {
		t.Fatal("selected source meters", meter)
	}
}

type fixtureIR struct{}

func (fixtureIR) GetIR(index int) ([][]float64, float64, bool) {
	return [][]float64{{1, .25, 0}, {.5, 0, .25}}, 48000, index == 1
}

func TestEveryRegisteredEffectPreviewPartitionResetAndOfflineExactParity(t *testing.T) {
	descriptors, err := Descriptors(48000)
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]string, len(descriptors))
	for i, descriptor := range descriptors {
		ids[i] = descriptor.ID
	}
	if !reflect.DeepEqual(ids, effectchain.DefaultRegistry().Types()) {
		t.Fatal("catalogue differs from authoritative registry", ids)
	}
	for _, descriptor := range descriptors {
		t.Run(descriptor.ID, func(t *testing.T) {
			document := testDocument(t, 9001, 2)
			selected := ops.Range{Start: 7, End: 8989, ChannelMask: 3}
			params := map[string]any{}
			for _, parameter := range descriptor.Parameters {
				if parameter.Type == "enum" {
					params[parameter.ID] = parameter.DefaultString
				} else {
					params[parameter.ID] = parameter.Default
				}
			}
			if descriptor.ID == "delay" {
				params["time"] = .01
			}
			if descriptor.ID == "pitch-time" || descriptor.ID == "pitch-spectral" {
				params["semitones"] = 12.0
			}
			if descriptor.ID == "filter-peak" {
				params["gain"] = 6.0
			}
			if descriptor.ID == "reverb-conv" {
				params["irIndex"] = 1.0
			}
			config, err := NewConfig(document, selected, testGraph(descriptor.ID, params), 1, false, fixtureIR{})
			if err != nil {
				t.Fatal(err)
			}
			one, err := NewStream(document, selected, config)
			if err != nil {
				t.Fatal(err)
			}
			reference := collectStream(t, one, selected.Start, int(selected.End-selected.Start), 382, 2)
			two, err := NewStream(document, selected, config)
			if err != nil {
				t.Fatal(err)
			}
			partitioned := collectStream(t, two, selected.Start, int(selected.End-selected.Start), 17, 2)
			if !reflect.DeepEqual(reference, partitioned) {
				t.Fatal("bridge partition changes actual effect output")
			}
			if err := two.Reset(selected.Start); err != nil {
				t.Fatal(err)
			}
			reset := collectStream(t, two, selected.Start, int(selected.End-selected.Start), 53, 2)
			if !reflect.DeepEqual(reference, reset) {
				t.Fatal("reset differs from fresh processor")
			}
			scratch := [][]float64{make([]float64, selected.End-selected.Start), make([]float64, selected.End-selected.Start)}
			if allocations := testing.AllocsPerRun(3, func() {
				if err := two.Reset(selected.Start); err != nil {
					panic(err)
				}
				if err := two.Read(scratch, selected.Start); err != nil {
					panic(err)
				}
			}); allocations != 0 {
				t.Fatalf("prepared %s render+reset allocate %g", descriptor.ID, allocations)
			}
			job, err := NewJob(document, selected, config, process.Limits{})
			if err != nil {
				t.Fatal(err)
			}
			candidate := finishJob(t, job)
			for channel := range 2 {
				output, _ := candidate.Channel(channel)
				samples := make([]float64, len(reference[channel]))
				output.ReadFloat64(samples, selected.Start)
				if !reflect.DeepEqual(reference[channel], samples) {
					t.Fatal("offline differs from actual preview")
				}
			}
		})
	}
}

func TestEffectJobCancellationBudgetPartialOwnershipAndSourceBits(t *testing.T) {
	document := testDocument(t, 9000, 3)
	selected := ops.Range{Start: 11, End: 8997, ChannelMask: 1}
	config, err := NewConfig(document, selected, testGraph("ringmod", nil), 1, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewJob(document, selected, config, process.Limits{MaxOutputBytes: 100}); err == nil {
		t.Fatal("output limit ignored")
	}
	job, err := NewJob(document, selected, config, process.Limits{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := job.Result(); err == nil {
		t.Fatal("unfinished candidate exposed")
	}
	if _, err := job.Step(context.Background()); err != nil {
		t.Fatal(err)
	}
	partial, err := job.MemoryDocument()
	if err != nil || partial.Frames() != 4096 || partial.Channels() != 1 {
		t.Fatal("partial memory", partial.Frames(), err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := job.Step(ctx); err == nil {
		t.Fatal("cancellation ignored")
	}
	job.Cancel()
	job.Cancel()
	if _, err := job.Result(); err == nil {
		t.Fatal("cancelled result exposed")
	}
	if _, err := job.MemoryDocument(); err == nil {
		t.Fatal("cancelled storage retained")
	}
	completed, err := NewJob(document, selected, config, process.Limits{})
	if err != nil {
		t.Fatal(err)
	}
	candidate := finishJob(t, completed)
	completed.Cancel()
	for channel := range 3 {
		source, _ := document.Channel(channel)
		output, _ := candidate.Channel(channel)
		a, b := make([]float32, 9000), make([]float32, 9000)
		source.Read(a, 0)
		output.Read(b, 0)
		for frame := range a {
			if channel == 0 && frame >= 11 && frame < 8997 {
				continue
			}
			if math.Float32bits(a[frame]) != math.Float32bits(b[frame]) {
				t.Fatal("source outside selection changed")
			}
		}
	}
	if candidate.Metadata().Name != document.Metadata().Name {
		t.Fatal("metadata changed")
	}
	if partial.Frames() != 4096 {
		t.Fatal("published immutable partial accounting mutated")
	}
}

func TestEffectPreparedRenderAndLoopResetAllocateNothing(t *testing.T) {
	document := testDocument(t, 257, 2)
	selected := ops.Range{Start: 0, End: 257, ChannelMask: 3}
	config, err := NewConfig(document, selected, testGraph("ringmod", nil), 1, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	stream, err := NewStream(document, selected, config)
	if err != nil {
		t.Fatal(err)
	}
	dst := [][]float64{make([]float64, 257), make([]float64, 257)}
	if allocs := testing.AllocsPerRun(25, func() {
		if err := stream.Reset(0); err != nil {
			panic(err)
		}
		if err := stream.Read(dst, 0); err != nil {
			panic(err)
		}
	}); allocs != 0 {
		t.Fatalf("prepared render/loop reset allocate %g", allocs)
	}
}
