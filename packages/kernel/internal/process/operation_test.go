package process

import (
	"context"
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
)

func operationDocument(t *testing.T, samples ...[]float32) audiobuf.Document {
	t.Helper()
	channels := make([]audiobuf.Channel, len(samples))
	for i := range channels {
		channels[i] = audiobuf.NewChannel(samples[i])
	}
	doc, err := audiobuf.NewDocument(channels, 48000, audiobuf.Metadata{Name: "fixture", Timeline: audiobuf.Timeline{NextID: 3, Markers: []audiobuf.Marker{{ID: 1, Frame: 1, Name: "point", Color: "#123456"}}, Regions: []audiobuf.Region{{ID: 2, Start: 0, End: int64(len(samples[0])), Name: "program", Color: "#123456"}}}})
	if err != nil {
		t.Fatal(err)
	}
	return doc
}

func operationSamples(t *testing.T, doc audiobuf.Document, channel int) []float32 {
	t.Helper()
	part, err := doc.Channel(channel)
	if err != nil {
		t.Fatal(err)
	}
	values := make([]float32, int(doc.Frames()))
	if got := part.Read(values, 0); got != len(values) {
		t.Fatalf("read %d of %d", got, len(values))
	}
	return values
}

func finishOperation(t *testing.T, stepper Stepper) audiobuf.Document {
	t.Helper()
	for range 10000 {
		progress, err := stepper.Step(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if progress.Done {
			result, err := stepper.Result()
			if err != nil {
				t.Fatal(err)
			}
			return result
		}
	}
	t.Fatal("operation did not finish")
	return audiobuf.Document{}
}

func TestSelectionOperationsGolden(t *testing.T) {
	tests := []struct {
		name     string
		settings Settings
		want     []float32
	}{
		{"fade in", Settings{Operation: "fade-in", Curve: "linear"}, []float32{5, 0, 1, 2, 7}},
		{"fade out", Settings{Operation: "fade-out", Curve: "linear"}, []float32{5, 2, 1, 0, 7}},
		{"reverse", Settings{Operation: "reverse"}, []float32{5, 2, 2, 2, 7}},
		{"invert", Settings{Operation: "invert"}, []float32{5, -2, -2, -2, 7}},
		{"DC", Settings{Operation: "remove-dc"}, []float32{5, 0, 0, 0, 7}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			document := operationDocument(t, []float32{5, 2, 2, 2, 7}, []float32{1, 2, 3, 4, 5})
			stepper, err := NewOperation(document, ops.Range{Start: 1, End: 4, ChannelMask: 1}, test.settings, Limits{})
			if err != nil {
				t.Fatal(err)
			}
			result := finishOperation(t, stepper)
			if got := operationSamples(t, result, 0); !reflect.DeepEqual(got, test.want) {
				t.Fatalf("got %v want %v", got, test.want)
			}
			if got := operationSamples(t, result, 1); !reflect.DeepEqual(got, []float32{1, 2, 3, 4, 5}) {
				t.Fatalf("unselected changed: %v", got)
			}
			if got := operationSamples(t, document, 0); !reflect.DeepEqual(got, []float32{5, 2, 2, 2, 7}) {
				t.Fatal("source changed")
			}
			if !reflect.DeepEqual(result.Metadata(), document.Metadata()) {
				t.Fatal("metadata changed")
			}
		})
	}
}

func TestFadeIndependentShapeVectors(t *testing.T) {
	tests := []struct {
		shape    string
		midpoint float32
	}{
		{"linear", 0.5}, {"equal-power", float32(math.Sqrt(0.5))}, {"logarithmic", float32(math.Log(5.5) / math.Log(10))}, {"s-curve", 0.5},
	}
	for _, test := range tests {
		t.Run(test.shape, func(t *testing.T) {
			document := operationDocument(t, []float32{1, 1, 1})
			stepper, err := NewOperation(document, ops.Range{End: 3, ChannelMask: 1}, Settings{Operation: "fade-in", Curve: test.shape}, Limits{})
			if err != nil {
				t.Fatal(err)
			}
			got := operationSamples(t, finishOperation(t, stepper), 0)
			if got[0] != 0 || got[2] != 1 || math.Abs(float64(got[1]-test.midpoint)) > 1e-7 {
				t.Fatalf("unexpected curve %v", got)
			}
		})
	}
}

func TestReverseBitsAcrossBlockBoundaries(t *testing.T) {
	values := make([]float32, audiobuf.BlockFrames*2+13)
	for i := range values {
		values[i] = math.Float32frombits(uint32(i) + 0x3f000000)
	}
	values[19], values[audiobuf.BlockFrames+2] = math.Float32frombits(0x80000000), math.Float32frombits(0x7f812345)
	document := operationDocument(t, values)
	selected := ops.Range{Start: 7, End: int64(len(values) - 5), ChannelMask: 1}
	stepper, err := NewOperation(document, selected, Settings{Operation: "reverse"}, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	result := operationSamples(t, finishOperation(t, stepper), 0)
	for i, sample := range result {
		j := i
		if int64(i) >= selected.Start && int64(i) < selected.End {
			j = int(selected.Start + selected.End - 1 - int64(i))
		}
		if math.Float32bits(sample) != math.Float32bits(values[j]) {
			t.Fatalf("frame%d bits got %x want%x", i, math.Float32bits(sample), math.Float32bits(values[j]))
		}
	}
}

func TestMultichannelFadeGlobalEnvelopeAndUnsafeTelemetry(t *testing.T) {
	frames := audiobuf.BlockFrames + 3
	for _, curve := range []string{"linear", "equal-power", "logarithmic", "s-curve"} {
		shape := func(x float64) float64 {
			switch curve {
			case "equal-power":
				return math.Sin(math.Pi * x / 2)
			case "logarithmic":
				return math.Log10(1 + 9*x)
			case "s-curve":
				return x * x * (3 - 2*x)
			default:
				return x
			}
		}
		for _, operation := range []string{"fade-in", "fade-out", "crossfade"} {
			t.Run(operation+"/"+curve, func(t *testing.T) {
				count := frames
				if operation == "crossfade" {
					count *= 2
				}
				unsafe, finite := make([]float32, count), make([]float32, count)
				for i := range finite {
					unsafe[i], finite[i] = 0.25, 0.25
					if operation == "crossfade" && i >= frames {
						unsafe[i], finite[i] = 0.75, 0.75
					}
				}
				unsafe[3] = math.Float32frombits(0x7f812345)
				document := operationDocument(t, unsafe, finite)
				selection := ops.Range{End: int64(count), ChannelMask: 3}
				if operation == "crossfade" {
					selection.Start, selection.End = int64(frames), int64(frames)
				}
				stepper, err := NewOperation(document, selection, Settings{Operation: operation, Curve: curve, DurationFrames: int64(frames)}, Limits{})
				if err != nil {
					t.Fatal(err)
				}
				result := finishOperation(t, stepper)
				got := operationSamples(t, result, 1)
				for _, position := range []int{0, 3, 31, frames / 2, audiobuf.BlockFrames - 1, audiobuf.BlockFrames, frames - 1} {
					x := float64(position) / float64(frames-1)
					want := .25 * shape(x)
					switch operation {
					case "fade-out":
						want = .25 * shape(1-x)
					case "crossfade":
						want = .25*shape(1-x) + .75*shape(x)
					}
					if math.Abs(float64(got[position])-want) > 1e-7 {
						t.Fatalf("position%d got%v want%v", position, got[position], want)
					}
				}
				_, nonfinite := stepper.(*blockOperation).Peak()
				if !nonfinite || !math.IsNaN(float64(operationSamples(t, result, 0)[3])) {
					t.Fatal("unsafe first-channel output lost")
				}
				original := operationSamples(t, document, 0)
				for i, value := range unsafe {
					if math.Float32bits(original[i]) != math.Float32bits(value) {
						t.Fatal("source changed during envelope reuse")
					}
				}
			})
		}
	}
}

func TestInvalidPreparedEnvelopeFailsWithoutPublishingOutput(t *testing.T) {
	document := operationDocument(t, []float32{1, 2, 3, 4}, []float32{1, 2, 3, 4})
	for _, operation := range []string{"fade-in", "crossfade"} {
		selection := ops.Range{End: 4, ChannelMask: 3}
		if operation == "crossfade" {
			selection.Start, selection.End = 2, 2
		}
		stepper, err := NewOperation(document, selection, Settings{Operation: operation, DurationFrames: 2}, Limits{})
		if err != nil {
			t.Fatal(err)
		}
		job := stepper.(*blockOperation)
		job.settings.Curve = "corrupt-private-curve"
		if _, err := job.Step(context.Background()); err == nil {
			t.Fatal("invalid envelope published a candidate")
		}
		if _, err := job.Result(); err == nil || job.other != nil || job.rising != nil || job.blocks != nil {
			t.Fatal("invalid envelope retained a candidate or scratch")
		}
		if !reflect.DeepEqual(operationSamples(t, document, 1), []float32{1, 2, 3, 4}) {
			t.Fatal("invalid envelope changed source")
		}
	}
}

func TestDCMeasuresWholeSelection(t *testing.T) {
	values := make([]float32, audiobuf.BlockFrames+3)
	for i := range values {
		values[i] = 1
	}
	values[len(values)-1] = 100
	document := operationDocument(t, values)
	stepper, err := NewOperation(document, ops.Range{End: int64(len(values)), ChannelMask: 1}, Settings{Operation: "remove-dc"}, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	got := operationSamples(t, finishOperation(t, stepper), 0)
	mean := 1 + 99/float64(len(values))
	for i, value := range got {
		want := float32(float64(values[i]) - mean)
		if value != want {
			t.Fatalf("frame%d got%g want%g", i, value, want)
		}
	}
}

func TestCrossfadeSpliceAndMetadata(t *testing.T) {
	document := operationDocument(t, []float32{10, 1, 2, 3, 4, 20}, []float32{30, 2, 4, 6, 8, 40})
	stepper, err := NewOperation(document, ops.Range{Start: 3, End: 3, ChannelMask: 1}, Settings{Operation: "crossfade", DurationFrames: 2, Curve: "linear"}, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	result := finishOperation(t, stepper)
	if got := operationSamples(t, result, 0); !reflect.DeepEqual(got, []float32{10, 1, 4, 20}) {
		t.Fatalf("crossfade %v", got)
	}
	if got := operationSamples(t, result, 1); !reflect.DeepEqual(got, []float32{30, 2, 8, 40}) {
		t.Fatalf("crossfade right %v", got)
	}
	metadata, err := document.Metadata().Timeline.Splice(6, 1, 5, 2)
	if err != nil || !reflect.DeepEqual(result.Metadata().Timeline, metadata) {
		t.Fatal("crossfade metadata mismatch")
	}
}

func TestChannelRoutingAndExtraction(t *testing.T) {
	document := operationDocument(t, []float32{1, 2, 3, 4}, []float32{8, 6, 4, 2})
	for _, test := range []struct {
		mode string
		want []float32
	}{{"mix", []float32{4.5, 4, 3.5, 3}}, {"left", []float32{1, 2, 3, 4}}, {"right", []float32{8, 6, 4, 2}}} {
		stepper, err := NewOperation(document, ops.Range{Start: 1, End: 3, ChannelMask: 3}, Settings{Operation: "stereo-to-mono", ChannelMode: test.mode}, Limits{})
		if err != nil {
			t.Fatal(err)
		}
		result := finishOperation(t, stepper)
		if result.Channels() != 1 || !reflect.DeepEqual(operationSamples(t, result, 0), test.want) {
			t.Fatalf("routing %s", test.mode)
		}
		if !reflect.DeepEqual(document.Metadata(), result.Metadata()) {
			t.Fatal("conversion metadata")
		}
	}
	stepper, err := NewOperation(document, ops.Range{Start: 1, End: 3, ChannelMask: 1}, Settings{Operation: "extract-channel", Channel: 1}, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	extracted := finishOperation(t, stepper)
	if !reflect.DeepEqual(operationSamples(t, extracted, 0), []float32{6, 4}) {
		t.Fatal("extraction samples")
	}
	if extracted.Metadata().Timeline.Markers[0].Frame != 0 || extracted.Metadata().Timeline.Regions[0].End != 2 {
		t.Fatal("extraction timeline")
	}
	stepper, err = NewOperation(extracted, ops.Range{End: 2, ChannelMask: 1}, Settings{Operation: "mono-to-stereo"}, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	stereo := finishOperation(t, stepper)
	if stereo.Channels() != 2 || !reflect.DeepEqual(operationSamples(t, stereo, 0), operationSamples(t, stereo, 1)) {
		t.Fatal("mono duplication")
	}
}

func TestGeneratorInsertionAndSelectionReplacement(t *testing.T) {
	document := operationDocument(t, []float32{1, 2, 3, 4}, []float32{5, 6, 7, 8})
	settings := Settings{Operation: "generate", Generator: "sine", Frequency: 12000, LevelDB: 0, DurationFrames: 4}
	stepper, err := NewOperation(document, ops.Range{Start: 2, End: 2, ChannelMask: 1}, settings, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	result := finishOperation(t, stepper)
	if result.Frames() != 8 {
		t.Fatal("insert length")
	}
	got := operationSamples(t, result, 0)
	if got[0] != 1 || got[1] != 2 || got[2] != 0 || got[3] != 1 || math.Abs(float64(got[4])) > 1e-6 || got[5] != -1 || got[6] != 3 || got[7] != 4 {
		t.Fatalf("tone output %v", got)
	}
	if !reflect.DeepEqual(operationSamples(t, result, 1), []float32{5, 6, 0, 0, 0, 0, 7, 8}) {
		t.Fatal("subset insertion must preserve sync")
	}
	metadata := result.Metadata()
	if metadata.Name != document.Metadata().Name || !reflect.DeepEqual(metadata.Timeline.Markers, document.Metadata().Timeline.Markers) || metadata.Timeline.Regions[0].Start != 0 || metadata.Timeline.Regions[0].End != 8 {
		t.Fatal("subset insertion timeline did not follow all channels")
	}

	settings.Generator = "silence"
	settings.DurationFrames = 999
	stepper, err = NewOperation(document, ops.Range{Start: 1, End: 3, ChannelMask: 3}, settings, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	result = finishOperation(t, stepper)
	if !reflect.DeepEqual(operationSamples(t, result, 0), []float32{1, 0, 0, 4}) || result.Frames() != 4 {
		t.Fatal("selection replacement duration")
	}
}

func TestGeneratorDeterminismAndIndependentChannels(t *testing.T) {
	document := operationDocument(t, []float32{0, 0, 0, 0}, []float32{0, 0, 0, 0})
	for _, kind := range []string{"white-noise", "pink-noise", "linear-sweep", "log-sweep"} {
		settings := Settings{Operation: "generate", Generator: kind, Frequency: 200, EndFrequency: 2000, LevelDB: -12, Seed: 123}
		first, err := NewOperation(document, ops.Range{End: 4, ChannelMask: 3}, settings, Limits{})
		if err != nil {
			t.Fatal(err)
		}
		second, err := NewOperation(document, ops.Range{End: 4, ChannelMask: 3}, settings, Limits{})
		if err != nil {
			t.Fatal(err)
		}
		a, b := finishOperation(t, first), finishOperation(t, second)
		if !reflect.DeepEqual(operationSamples(t, a, 0), operationSamples(t, b, 0)) {
			t.Fatal("generator is not reproducible")
		}
		if (kind == "white-noise" || kind == "pink-noise") && reflect.DeepEqual(operationSamples(t, a, 0), operationSamples(t, a, 1)) {
			t.Fatal("noise channels coupled")
		}
	}
}

func TestDeterministicGeneratorSharedBlocksAndGlobalPhase(t *testing.T) {
	frames := audiobuf.BlockFrames + 11
	values := make([]float32, frames+2)
	for i := range values {
		values[i] = 0.25
	}
	document := operationDocument(t, values, values, values)
	selected := ops.Range{Start: 1, End: int64(frames + 1), ChannelMask: 5}
	for _, kind := range []string{"silence", "sine", "linear-sweep", "log-sweep"} {
		t.Run(kind, func(t *testing.T) {
			settings := Settings{Operation: "generate", Generator: kind, Frequency: 200, EndFrequency: 2000, LevelDB: 0, Seed: 123}
			stepper, err := NewOperation(document, selected, settings, Limits{})
			if err != nil {
				t.Fatal(err)
			}
			job := stepper.(*blockOperation)
			if _, err := job.Step(context.Background()); err != nil {
				t.Fatal(err)
			}
			if len(job.generators) != 1 || job.generators[0].Position() != audiobuf.BlockFrames || job.blocks[0][0] != job.blocks[1][0] {
				t.Fatal("identical channels did not share one immutable generated block")
			}
			retained := job.blocks[0][0]
			result := finishOperation(t, stepper)
			left, right := operationSamples(t, result, 0), operationSamples(t, result, 2)
			if !reflect.DeepEqual(left, right) || !reflect.DeepEqual(operationSamples(t, result, 1), values) {
				t.Fatal("selected channel mapping or unselected content changed")
			}
			for _, position := range []int{0, 1, 31, audiobuf.BlockFrames - 1, audiobuf.BlockFrames, frames - 1} {
				n := float64(position)
				time := n / 48000
				phase := 2 * math.Pi * 200 * time
				switch kind {
				case "silence":
					phase = 0
				case "linear-sweep":
					phase += math.Pi * (2000 - 200) / (float64(frames) / 48000) * time * time
				case "log-sweep":
					k := math.Log(2000.0/200) / (float64(frames) / 48000)
					phase = 2 * math.Pi * 200 * math.Expm1(k*time) / k
				}
				if got, want := float64(left[position+1]), math.Sin(phase); math.Abs(got-want) > 1e-6 {
					t.Fatalf("global position%d got%v want%v", position, got, want)
				}
			}
			if left[0] != 0.25 || left[len(left)-1] != 0.25 || !reflect.DeepEqual(operationSamples(t, document, 0), values) {
				t.Fatal("selection boundaries or source ownership changed")
			}
			before := make([]float32, retained.Frames())
			retained.Read(before, 0)
			stepper.Cancel()
			left[1] = 99
			after := make([]float32, retained.Frames())
			retained.Read(after, 0)
			if !reflect.DeepEqual(before, after) || operationSamples(t, result, 2)[1] != before[0] {
				t.Fatal("shared storage mutated through a caller or cancellation")
			}
		})
	}
}

func TestOperationCancellationAndLimits(t *testing.T) {
	values := make([]float32, audiobuf.BlockFrames+1)
	document := operationDocument(t, values)
	for _, op := range []string{"reverse", "invert", "remove-dc", "fade-in", "generate", "resample"} {
		settings := Settings{Operation: op, Curve: "linear", Generator: "silence", SampleRate: 44100}
		stepper, err := NewOperation(document, ops.Range{End: int64(len(values)), ChannelMask: 1}, settings, Limits{})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := stepper.Step(context.Background()); err != nil {
			t.Fatal(err)
		}
		if _, err := stepper.Result(); err == nil {
			t.Fatalf("%s partial result published", op)
		}
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if _, err := stepper.Step(ctx); !errors.Is(err, context.Canceled) {
			t.Fatalf("%s cancellation: %v", op, err)
		}
		if _, err := stepper.Result(); !errors.Is(err, context.Canceled) {
			t.Fatal("cancelled result exposed")
		}
		stepper.Cancel()
		if _, err := NewOperation(document, ops.Range{End: int64(len(values)), ChannelMask: 1}, settings, Limits{MaxOutputBytes: 4}); err == nil {
			t.Fatalf("%s budget accepted", op)
		}
	}
}

func TestResampleDimensionsCoordinatesAndQuality(t *testing.T) {
	document := operationDocument(t, []float32{0, 0, 1, 0, 0, 0, 0})
	for _, quality := range []string{"fast", "balanced", "best"} {
		stepper, err := NewOperation(document, ops.Range{Start: 2, End: 5, ChannelMask: 1}, Settings{Operation: "resample", SampleRate: 96000, Quality: quality}, Limits{})
		if err != nil {
			t.Fatal(err)
		}
		result := finishOperation(t, stepper)
		if result.Frames() != 14 || result.SampleRate() != 96000 || result.Metadata().Timeline.Markers[0].Frame != 2 || result.Metadata().Timeline.Regions[0].End != 14 {
			t.Fatal("resample dimensions/timeline")
		}
		if got := stepper.(interface{ OutputSelection() ops.Range }).OutputSelection(); got.Start != 4 || got.End != 10 {
			t.Fatal("selection mapping")
		}
		got := operationSamples(t, result, 0)
		peakIndex := 0
		for i, sample := range got {
			if math.Abs(float64(sample)) > math.Abs(float64(got[peakIndex])) {
				peakIndex = i
			}
		}
		if peakIndex < 3 || peakIndex > 4 {
			t.Fatalf("delay not trimmed: peak%d %v", peakIndex, got)
		}
	}
}

func TestOperationFragmentedStorageParity(t *testing.T) {
	values := make([]float32, audiobuf.BlockFrames+37)
	for i := range values {
		values[i] = float32(math.Sin(float64(i)*0.03))*0.25 + 0.1
	}
	ordinary := operationDocument(t, values)
	var blocks []*audiobuf.Block
	for offset := 0; offset < len(values); {
		count := min(997, len(values)-offset)
		block, err := audiobuf.NewBlock(values[offset : offset+count])
		if err != nil {
			t.Fatal(err)
		}
		blocks = append(blocks, block)
		offset += count
	}
	channel, err := audiobuf.NewChannelFromBlocks(blocks)
	if err != nil {
		t.Fatal(err)
	}
	fragmented, err := audiobuf.NewDocument([]audiobuf.Channel{channel}, ordinary.SampleRate(), ordinary.Metadata())
	if err != nil {
		t.Fatal(err)
	}
	for _, settings := range []Settings{{Operation: "fade-out", Curve: "s-curve"}, {Operation: "reverse"}, {Operation: "remove-dc"}, {Operation: "resample", SampleRate: 44100, Quality: "best"}, {Operation: "generate", Generator: "pink-noise", LevelDB: -12, Seed: 432}, {Operation: "generate", Generator: "sine", Frequency: 1234}, {Operation: "generate", Generator: "linear-sweep", Frequency: 200, EndFrequency: 2000}, {Operation: "generate", Generator: "log-sweep", Frequency: 200, EndFrequency: 2000}} {
		selected := ops.Range{Start: 13, End: int64(len(values) - 19), ChannelMask: 1}
		a, err := NewOperation(ordinary, selected, settings, Limits{})
		if err != nil {
			t.Fatal(err)
		}
		b, err := NewOperation(fragmented, selected, settings, Limits{})
		if err != nil {
			t.Fatal(err)
		}
		first, second := finishOperation(t, a), finishOperation(t, b)
		if !reflect.DeepEqual(operationSamples(t, first, 0), operationSamples(t, second, 0)) || !reflect.DeepEqual(first.Metadata(), second.Metadata()) {
			t.Fatalf("%s depends on source storage partition", settings.Operation)
		}
	}
}

func TestResampleExtremeRatiosAndWorkspace(t *testing.T) {
	for _, rates := range [][2]int{{8000, 384000}, {384000, 8000}, {44100, 48000}, {48000, 44100}} {
		values := make([]float32, 1001)
		values[43] = 1
		base := operationDocument(t, values)
		channel, _ := base.Channel(0)
		document, err := audiobuf.NewDocument([]audiobuf.Channel{channel}, rates[0], base.Metadata())
		if err != nil {
			t.Fatal(err)
		}
		stepper, err := NewOperation(document, ops.Range{End: 1001, ChannelMask: 1}, Settings{Operation: "resample", SampleRate: rates[1], Quality: "best"}, Limits{})
		if err != nil {
			t.Fatal(err)
		}
		result := finishOperation(t, stepper)
		want := (int64(1001)*int64(rates[1]) + int64(rates[0]) - 1) / int64(rates[0])
		if result.Frames() != want {
			t.Fatalf("ratio%v got%d want%d", rates, result.Frames(), want)
		}
	}
	base := operationDocument(t, []float32{0, 1, 0})
	channel, _ := base.Channel(0)
	document, err := audiobuf.NewDocument([]audiobuf.Channel{channel}, 383999, base.Metadata())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewOperation(document, ops.Range{End: 3, ChannelMask: 1}, Settings{Operation: "resample", SampleRate: 384000, Quality: "best"}, Limits{}); err == nil {
		t.Fatal("unbounded exact-rate workspace accepted")
	}
	// This coprime ratio fits under the ceiling only if float64 output
	// telemetry scratch is omitted. Reject before allocating its large filter.
	if _, err := NewOperation(base, ops.Range{End: 3, ChannelMask: 1}, Settings{Operation: "resample", SampleRate: 61927, Quality: "best"}, Limits{}); err == nil {
		t.Fatal("workspace budget omitted output telemetry scratch")
	}
}

func TestGeneratorEmptyDocumentAndCompletedCancellation(t *testing.T) {
	document, err := audiobuf.NewDocument([]audiobuf.Channel{{}, {}}, 48000, audiobuf.Metadata{Name: "empty"})
	if err != nil {
		t.Fatal(err)
	}
	stepper, err := NewOperation(document, ops.Range{ChannelMask: 3}, Settings{Operation: "generate", Generator: "silence", DurationFrames: 4}, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	result := finishOperation(t, stepper)
	stepper.Cancel()
	if _, err := stepper.Result(); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled completed candidate available")
	}
	if result.Frames() != 4 || !reflect.DeepEqual(operationSamples(t, result, 1), []float32{0, 0, 0, 0}) || document.Frames() != 0 {
		t.Fatal("empty generation/caller-owned result changed")
	}
}

func TestOperationInvalidSettings(t *testing.T) {
	document := operationDocument(t, []float32{1, 2, 3, 4})
	for _, settings := range []Settings{{Operation: "unknown"}, {Operation: "crossfade", DurationFrames: 1}, {Operation: "fade-in", Curve: "unknown"}, {Operation: "stereo-to-mono", ChannelMode: "mix"}, {Operation: "extract-channel", Channel: 1}, {Operation: "resample", SampleRate: 7999}, {Operation: "resample", SampleRate: 48000, Quality: "unknown"}, {Operation: "generate", Generator: "unknown"}, {Operation: "generate", Generator: "sine", Frequency: 48000}, {Operation: "generate", Generator: "silence", LevelDB: math.NaN()}} {
		if _, err := NewOperation(document, ops.Range{End: 4, ChannelMask: 1}, settings, Limits{}); err == nil {
			t.Fatalf("invalid settings accepted: %+v", settings)
		}
	}
}

func TestDCSecondPhaseCancellation(t *testing.T) {
	document := operationDocument(t, []float32{1, 2, 3, 4})
	stepper, err := NewOperation(document, ops.Range{End: 4, ChannelMask: 1}, Settings{Operation: "remove-dc"}, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := stepper.Step(context.Background()); err != nil {
		t.Fatal(err)
	}
	if stepper.(interface{ Status() NormalizationStatus }).Status().Phase != "processing" {
		t.Fatal("did not complete whole-range analysis")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := stepper.Step(ctx); !errors.Is(err, context.Canceled) {
		t.Fatal("processing cancellation lost")
	}
	if !reflect.DeepEqual(operationSamples(t, document, 0), []float32{1, 2, 3, 4}) {
		t.Fatal("source changed by cancelled DC operation")
	}
}

func TestConvertedStorageAndWarningParity(t *testing.T) {
	for _, samples := range [][]float64{{math.Copysign(0, -1), 0.125, -0.75, 1.125}, {math.Copysign(0, -1), math.NaN(), math.Inf(1), math.MaxFloat64, -2, math.Inf(-1)}} {
		direct := &blockOperation{blocks: make([][]*audiobuf.Block, 1), mono: make([]float32, audiobuf.BlockFrames), dsp: make([]float64, audiobuf.BlockFrames)}
		copied := &blockOperation{blocks: make([][]*audiobuf.Block, 1), mono: make([]float32, audiobuf.BlockFrames), dsp: make([]float64, audiobuf.BlockFrames)}
		for i, sample := range samples {
			copied.mono[i] = float32(sample)
		}
		if err := direct.storeConverted(0, samples); err != nil {
			t.Fatal(err)
		}
		if err := copied.store(0, len(samples)); err != nil {
			t.Fatal(err)
		}
		a, b := make([]float32, len(samples)), make([]float32, len(samples))
		direct.blocks[0][0].Read(a, 0)
		copied.blocks[0][0].Read(b, 0)
		for i := range a {
			if math.Float32bits(a[i]) != math.Float32bits(b[i]) {
				t.Fatalf("frame%d directbits%x copybits%x", i, math.Float32bits(a[i]), math.Float32bits(b[i]))
			}
		}
		peak, unsafe := direct.Peak()
		otherPeak, otherUnsafe := copied.Peak()
		if peak != otherPeak || unsafe != otherUnsafe {
			t.Fatalf("warnings direct%v/%v copy%v/%v", peak, unsafe, otherPeak, otherUnsafe)
		}
	}
}

func TestSharedRoutingCachedAndUnsafePeakParity(t *testing.T) {
	for _, values := range [][]float32{{0, 0.25, -0.5, 1.25}, {math.Float32frombits(0x80000000), math.Float32frombits(0x7f812345), math.Float32frombits(0x7f800000), -2}} {
		document := operationDocument(t, values)
		for _, settings := range []Settings{{Operation: "mono-to-stereo"}, {Operation: "extract-channel", Channel: 0}, {Operation: "resample", SampleRate: 48000}} {
			stepper, err := NewOperation(document, ops.Range{End: 4, ChannelMask: 1}, settings, Limits{})
			if err != nil {
				t.Fatal(err)
			}
			result := finishOperation(t, stepper)
			got := operationSamples(t, result, 0)
			for i := range values {
				if math.Float32bits(got[i]) != math.Float32bits(values[i]) {
					t.Fatalf("%s changed samplebits", settings.Operation)
				}
			}
			peak, unsafe := stepper.Peak()
			wantPeak := 1.25
			if math.IsNaN(float64(values[1])) {
				wantPeak = 2
			}
			if peak != wantPeak || unsafe != (wantPeak == 2) {
				t.Fatalf("%s peak%v unsafe%v", settings.Operation, peak, unsafe)
			}
		}
	}
}

func TestOperationRejectsMalformedDocumentSelectionAndLimits(t *testing.T) {
	document := operationDocument(t, []float32{1, 2, 3, 4})
	invalidRate, _ := audiobuf.NewDocument([]audiobuf.Channel{audiobuf.NewChannel([]float32{1})}, 1, audiobuf.Metadata{})
	tooMany, _ := audiobuf.NewDocument(make([]audiobuf.Channel, 9), 48000, audiobuf.Metadata{})
	for _, operation := range []string{"reverse", "resample"} {
		settings := Settings{Operation: operation, SampleRate: 44100}
		for _, bad := range []audiobuf.Document{{}, invalidRate, tooMany} {
			if _, err := NewOperation(bad, ops.Range{ChannelMask: 1}, settings, Limits{}); err == nil {
				t.Fatalf("%s accepted malformed format", operation)
			}
		}
		for _, bad := range []ops.Range{{Start: -1, End: 1, ChannelMask: 1}, {Start: 3, End: 2, ChannelMask: 1}, {End: 5, ChannelMask: 1}, {End: 4}, {End: 4, ChannelMask: 2}, {End: 4, ChannelMask: -1}} {
			if _, err := NewOperation(document, bad, settings, Limits{}); err == nil {
				t.Fatalf("%s accepted invalid selection%+v", operation, bad)
			}
		}
		for _, budget := range []int64{-1, DefaultMaxOutputBytes + 1} {
			if _, err := NewOperation(document, ops.Range{End: 4, ChannelMask: 1}, settings, Limits{MaxOutputBytes: budget}); err == nil {
				t.Fatal("invalid budget accepted")
			}
		}
	}
	stereo := operationDocument(t, []float32{1, 2, 3, 4}, []float32{1, 2, 3, 4})
	if _, err := NewOperation(stereo, ops.Range{End: 4, ChannelMask: 3}, Settings{Operation: "mono-to-stereo"}, Limits{}); err == nil {
		t.Fatal("stereo expansion accepted")
	}
	for _, settings := range []Settings{{Operation: "crossfade", Curve: "unknown", DurationFrames: 2}, {Operation: "crossfade", DurationFrames: 3}, {Operation: "generate", Generator: "silence"}, {Operation: "generate", Generator: "silence", DurationFrames: -1}, {Operation: "generate", Generator: "silence", DurationFrames: 4, LevelDB: 1}, {Operation: "generate", Generator: "silence", DurationFrames: 4, LevelDB: -121}, {Operation: "generate", Generator: "silence", DurationFrames: 4, LevelDB: math.Inf(1)}} {
		if _, err := NewOperation(document, ops.Range{Start: 2, End: 2, ChannelMask: 1}, settings, Limits{}); err == nil {
			t.Fatalf("invalidsettings accepted %+v", settings)
		}
	}
	empty, _ := audiobuf.NewDocument([]audiobuf.Channel{{}}, 48000, audiobuf.Metadata{})
	if _, err := NewOperation(empty, ops.Range{ChannelMask: 1}, Settings{Operation: "reverse"}, Limits{}); err == nil {
		t.Fatal("empty reverse accepted")
	}
}

func TestOperationFactoryDefaultsAndInitialMetadata(t *testing.T) {
	document := operationDocument(t, []float32{1, 1, 1, 1})
	for _, test := range []struct {
		settings Settings
		selected ops.Range
		want     []float32
		identity bool
	}{
		{Settings{Operation: "gain", GainDB: 0}, ops.Range{End: 4, ChannelMask: 1}, []float32{1, 1, 1, 1}, true},
		{Settings{Operation: "normalize-peak", TargetDB: -6.020599913279624}, ops.Range{End: 4, ChannelMask: 1}, []float32{0.5, 0.5, 0.5, 0.5}, false},
		{Settings{Operation: "fade-in"}, ops.Range{Start: 2, End: 2, ChannelMask: 1}, []float32{0, 1.0 / 3, 2.0 / 3, 1}, false},
		{Settings{Operation: "crossfade", DurationFrames: 2}, ops.Range{Start: 2, End: 2, ChannelMask: 1}, []float32{1, 1}, false},
		{Settings{Operation: "extract-channel", Channel: 0}, ops.Range{Start: 2, End: 2, ChannelMask: 1}, []float32{1, 1, 1, 1}, false},
		{Settings{Operation: "resample", SampleRate: 48000}, ops.Range{Start: 1, End: 3, ChannelMask: 1}, []float32{1, 1, 1, 1}, true},
	} {
		stepper, err := NewOperation(document, test.selected, test.settings, Limits{})
		if err != nil {
			t.Fatal(err)
		}
		initial := stepper.(interface{ Progress() Progress }).Progress()
		if initial.FramesDone != 0 || initial.Done || initial.FramesTotal != int64(len(test.want)) {
			t.Fatalf("%s incorrectinitialprogress %+v", test.settings.Operation, initial)
		}
		if stepper.Identity() != test.identity {
			t.Fatalf("%s identityclassification", test.settings.Operation)
		}
		if provider, ok := stepper.(interface{ OutputFormat() (int, int, int64) }); ok {
			rate, channels, frames := provider.OutputFormat()
			if rate != 48000 || channels != 1 || frames != int64(len(test.want)) {
				t.Fatal("candidateformat changed")
			}
		}
		result := finishOperation(t, stepper)
		if !reflect.DeepEqual(operationSamples(t, result, 0), test.want) {
			t.Fatalf("%s output %v", test.settings.Operation, operationSamples(t, result, 0))
		}
		again, err := stepper.Step(context.Background())
		if err != nil || !again.Done {
			t.Fatal("completed step was not stable")
		}
	}
}

func TestOperationPartialMemoryOwnership(t *testing.T) {
	values := make([]float32, audiobuf.BlockFrames+3)
	for i := range values {
		values[i] = float32(i%64) * 0.01
	}
	document := operationDocument(t, values)
	for _, settings := range []Settings{{Operation: "invert"}, {Operation: "remove-dc"}, {Operation: "generate", Generator: "silence"}, {Operation: "resample", SampleRate: 44100}} {
		stepper, err := NewOperation(document, ops.Range{End: int64(len(values)), ChannelMask: 1}, settings, Limits{})
		if err != nil {
			t.Fatal(err)
		}
		before, err := stepper.MemoryDocument()
		if err != nil || before.Frames() != 0 {
			t.Fatal("newcandidate contains output")
		}
		for {
			progress, err := stepper.Step(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			memory, err := stepper.MemoryDocument()
			if err != nil {
				t.Fatal(err)
			}
			if memory.Frames() == 0 {
				if progress.Done {
					t.Fatal("completed empty result")
				}
				continue
			}
			if progress.Done {
				t.Fatal("fixture did not retain partial output")
			}
			if len(memory.Metadata().Timeline.Markers) != 0 || len(memory.Metadata().Timeline.Regions) != 0 {
				t.Fatal("partialmemory retained source annotations")
			}
			saved := operationSamples(t, memory, 0)
			stepper.Cancel()
			if _, err := stepper.MemoryDocument(); !errors.Is(err, context.Canceled) {
				t.Fatal("cancelledcandidate owns partial output")
			}
			if !reflect.DeepEqual(operationSamples(t, memory, 0), saved) {
				t.Fatal("caller-owned partial memory invalidated")
			}
			if !reflect.DeepEqual(operationSamples(t, document, 0), values) {
				t.Fatal("source changed")
			}
			break
		}
	}
	shared, err := NewOperation(document, ops.Range{End: int64(len(values)), ChannelMask: 1}, Settings{Operation: "mono-to-stereo"}, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	if partial, err := shared.MemoryDocument(); err != nil || partial.Channels() != 0 {
		t.Fatal("sharedrouting reported new samplememory")
	}
	result := finishOperation(t, shared)
	memory, err := shared.MemoryDocument()
	if err != nil || memory.Frames() != result.Frames() || memory.Channels() != 2 {
		t.Fatal("completedcandidate memory mismatch")
	}
}

// A context whose cancellation is triggered at a known cancellation boundary
// makes in-Step failure atomicity deterministic without scheduler-dependent races.
type operationCancelBoundary struct{ remaining int }

func (c *operationCancelBoundary) Deadline() (time.Time, bool) { return time.Time{}, false }
func (c *operationCancelBoundary) Done() <-chan struct{}       { return nil }
func (c *operationCancelBoundary) Err() error {
	c.remaining--
	if c.remaining <= 0 {
		return context.Canceled
	}
	return nil
}
func (c *operationCancelBoundary) Value(any) any { return nil }

func TestOperationCancellationInsideStep(t *testing.T) {
	document := operationDocument(t, []float32{1, 2, 3, 4}, []float32{2, 3, 4, 5})
	for _, settings := range []Settings{{Operation: "reverse"}, {Operation: "remove-dc"}, {Operation: "mono-to-stereo"}, {Operation: "resample", SampleRate: 44100}, {Operation: "resample", SampleRate: 48000}, {Operation: "generate", Generator: "silence"}, {Operation: "generate", Generator: "sine", Frequency: 12000}} {
		source := document
		mask := 3
		if settings.Operation == "mono-to-stereo" {
			source = operationDocument(t, []float32{1, 2, 3, 4})
			mask = 1
		}
		for _, boundary := range []int{1, 2, 3, 4, 5} {
			stepper, err := NewOperation(source, ops.Range{End: 4, ChannelMask: mask}, settings, Limits{})
			if err != nil {
				t.Fatal(err)
			}
			_, err = stepper.Step(&operationCancelBoundary{remaining: boundary})
			if err == nil {
				stepper.Cancel()
				continue
			}
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("unexpectedfailure %s/%d %v", settings.Operation, boundary, err)
			}
			if _, again := stepper.Step(context.Background()); !errors.Is(again, context.Canceled) {
				t.Fatal("failure was not terminal")
			}
			if _, again := stepper.Result(); !errors.Is(again, context.Canceled) {
				t.Fatal("cancelledresult exposed")
			}
			if _, again := stepper.MemoryDocument(); !errors.Is(again, context.Canceled) {
				t.Fatal("cancelledretainedmemory exposed")
			}
			stepper.Cancel()
		}
	}
	for _, settings := range []Settings{{Operation: "reverse"}, {Operation: "resample", SampleRate: 44100}} {
		stepper, err := NewOperation(document, ops.Range{End: 4, ChannelMask: 3}, settings, Limits{})
		if err != nil {
			t.Fatal(err)
		}
		var invalidContext context.Context
		if _, err := stepper.Step(invalidContext); err == nil {
			t.Fatal("nilcontext accepted")
		}
	}
}

func TestResampleEmptyAndCollapsedAnnotationMappings(t *testing.T) {
	empty, _ := audiobuf.NewDocument([]audiobuf.Channel{{}, {}}, 48000, audiobuf.Metadata{})
	stepper, err := NewOperation(empty, ops.Range{ChannelMask: 3}, Settings{Operation: "resample", SampleRate: 44100}, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	result := finishOperation(t, stepper)
	if result.Frames() != 0 || result.SampleRate() != 44100 || result.Channels() != 2 {
		t.Fatal("emptyresample format")
	}
	stepper.Cancel()
	values := make([]float32, 1001)
	document, err := audiobuf.NewDocument([]audiobuf.Channel{audiobuf.NewChannel(values)}, 384000, audiobuf.Metadata{Timeline: audiobuf.Timeline{NextID: 5, Markers: []audiobuf.Marker{{ID: 1, Frame: 1001, Name: "end", Color: "#123456"}}, Regions: []audiobuf.Region{{ID: 2, Start: 0, End: 1, Name: "collapse", Color: "#123456"}, {ID: 3, Start: 46, End: 97, Name: "retained", Color: "#123456"}}}})
	if err != nil {
		t.Fatal(err)
	}
	stepper, err = NewOperation(document, ops.Range{Start: 1, End: 3, ChannelMask: 1}, Settings{Operation: "resample", SampleRate: 8000}, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	result = finishOperation(t, stepper)
	metadata := result.Metadata().Timeline
	if metadata.NextID != 5 || metadata.Markers[0].Frame != 21 || len(metadata.Regions) != 1 || metadata.Regions[0].ID != 3 || metadata.Regions[0].Start != 1 || metadata.Regions[0].End != 2 {
		t.Fatalf("scaledmetadata %+v", metadata)
	}
	if selection := stepper.(interface{ OutputSelection() ops.Range }).OutputSelection(); selection.Start != 0 || selection.End != 0 {
		t.Fatal("collapsedselection not mapped to cursor")
	}
}

func TestDCRejectsNonfiniteWithoutPublishingCandidate(t *testing.T) {
	document := operationDocument(t, []float32{1, math.Float32frombits(0x7f812345), -2, 3})
	stepper, err := NewOperation(document, ops.Range{End: 4, ChannelMask: 1}, Settings{Operation: "remove-dc"}, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := stepper.Step(context.Background()); err == nil {
		t.Fatal("nonfiniteDC accepted")
	}
	if _, err := stepper.Result(); err == nil {
		t.Fatal("failedDC resultpublished")
	}
	if _, err := stepper.MemoryDocument(); err == nil {
		t.Fatal("failedDC memoryretained")
	}
	if math.Float32bits(operationSamples(t, document, 0)[1]) != 0x7f812345 {
		t.Fatal("failedDC changedsource")
	}
}

func TestOperationFailsClosedOnRetainedSourceReadFailure(t *testing.T) {
	// Deliberately truncate only the job's retained input handles. This models
	// a storage integrity failure without mutating the caller's immutable source.
	// No partial channel, metadata or progress may become a usable candidate.
	for _, test := range []struct {
		settings  Settings
		selection ops.Range
		channel   int
		retained  []float32
		message   string
	}{
		{Settings{Operation: "reverse"}, ops.Range{End: 4, ChannelMask: 3}, 0, []float32{1}, "short input read"},
		{Settings{Operation: "remove-dc"}, ops.Range{End: 4, ChannelMask: 3}, 0, []float32{1}, "short read"},
		{Settings{Operation: "crossfade", DurationFrames: 2}, ops.Range{Start: 2, End: 2, ChannelMask: 3}, 0, []float32{1, 2}, "short crossfade read"},
		{Settings{Operation: "stereo-to-mono", ChannelMode: "mix"}, ops.Range{End: 4, ChannelMask: 3}, 1, []float32{1}, "short right read"},
		{Settings{Operation: "extract-channel", Channel: 0}, ops.Range{End: 4, ChannelMask: 3}, 0, []float32{1}, "source peak"},
		{Settings{Operation: "resample", SampleRate: 44100}, ops.Range{End: 4, ChannelMask: 3}, 0, []float32{1}, "short channel read"},
	} {
		document := operationDocument(t, []float32{1, 2, 3, 4}, []float32{5, 6, 7, 8})
		stepper, err := NewOperation(document, test.selection, test.settings, Limits{})
		if err != nil {
			t.Fatal(err)
		}
		var operation *blockOperation
		switch job := stepper.(type) {
		case *blockOperation:
			operation = job
		case *rateOperation:
			operation = job.blockOperation
		}
		operation.channels[test.channel] = audiobuf.NewChannel(test.retained)
		progress, err := stepper.Step(context.Background())
		if err == nil || !strings.Contains(err.Error(), test.message) || progress.Done {
			t.Fatalf("%s integrityfailure %+v/%v", test.settings.Operation, progress, err)
		}
		if _, err := stepper.Result(); err == nil {
			t.Fatal("corruptsource published result")
		}
		if _, err := stepper.MemoryDocument(); err == nil {
			t.Fatal("corruptsource retained new output")
		}
		if !reflect.DeepEqual(operationSamples(t, document, 0), []float32{1, 2, 3, 4}) || !reflect.DeepEqual(operationSamples(t, document, 1), []float32{5, 6, 7, 8}) {
			t.Fatal("failure mutated source")
		}
	}
}

func TestResampleRejectsDivergedChannelClocks(t *testing.T) {
	document := operationDocument(t, []float32{1, 2, 3, 4}, []float32{5, 6, 7, 8})
	stepper, err := NewOperation(document, ops.Range{End: 4, ChannelMask: 3}, Settings{Operation: "resample", SampleRate: 44100}, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	job := stepper.(*rateOperation)
	// Advance one independent DSP stream to simulate a lost channel clock.
	if _, err := job.streams[1].ProcessInto(make([]float64, 32), make([]float64, 9)); err != nil {
		t.Fatal(err)
	}
	if progress, err := stepper.Step(context.Background()); err == nil || !strings.Contains(err.Error(), "channel clocks differ") || progress.Done {
		t.Fatalf("clock divergence did not failclosed %+v/%v", progress, err)
	}
	if _, err := stepper.Result(); err == nil {
		t.Fatal("divergedchannel outputpublished")
	}
	if _, err := stepper.MemoryDocument(); err == nil {
		t.Fatal("divergedchannel partialmemoryretained")
	}
}

func TestGeneratorSubsetInsertionSyncAtEveryCursor(t *testing.T) {
	for _, count := range []int{2, 6} {
		for _, cursor := range []int64{0, 4, 8} {
			for _, mask := range []int{1, 1 << (count - 1), 3} {
				input := make([][]float32, count)
				for ch := range count {
					input[ch] = make([]float32, 8)
					for frame := range 8 {
						input[ch][frame] = float32(10*ch + frame + 1)
					}
				}
				document := operationDocument(t, input...)
				stepper, err := NewOperation(document, ops.Range{Start: cursor, End: cursor, ChannelMask: mask}, Settings{Operation: "generate", Generator: "silence", DurationFrames: 3}, Limits{})
				if err != nil {
					t.Fatal(err)
				}
				result := finishOperation(t, stepper)
				if result.Frames() != 11 {
					t.Fatal("duration")
				}
				for ch := range count {
					want := append([]float32(nil), input[ch][:cursor]...)
					want = append(want, 0, 0, 0)
					want = append(want, input[ch][cursor:]...)
					if !reflect.DeepEqual(operationSamples(t, result, ch), want) {
						t.Fatalf("channels %d cursor %d mask %d ch %d: sync lost", count, cursor, mask, ch)
					}
					if !reflect.DeepEqual(operationSamples(t, document, ch), input[ch]) {
						t.Fatal("source modified")
					}
				}
				wantMarker := int64(1)
				if wantMarker >= cursor {
					wantMarker += 3
				}
				if result.Metadata().Timeline.Markers[0].Frame != wantMarker {
					t.Fatal("marker no longer aligned with source")
				}
			}
		}
	}
}
