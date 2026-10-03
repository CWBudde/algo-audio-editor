package process

import (
	"context"
	"errors"
	"math"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	"github.com/cwbudde/algo-dsp/dsp/core"
	"github.com/cwbudde/algo-dsp/dsp/filter/biquad"
	vecmath "github.com/cwbudde/algo-vecmath"
)

type processorFunc func([]float64) error

func (f processorFunc) ProcessBlock(block []float64) error { return f(block) }

type processFunc func(int, int, int64) (Processor, error)

func (f processFunc) NewChannel(rate, channel int, frames int64) (Processor, error) {
	return f(rate, channel, frames)
}

func fixture(t testing.TB, samples ...[]float32) audiobuf.Document {
	t.Helper()
	channels := make([]audiobuf.Channel, len(samples))
	for i := range channels {
		channels[i] = audiobuf.NewChannel(samples[i])
	}
	document, err := audiobuf.NewDocument(channels, 48000, audiobuf.Metadata{Name: "source.wav", Tags: map[string]string{"artist": "original"}, Timeline: audiobuf.Timeline{NextID: 3, Markers: []audiobuf.Marker{{ID: 1, Frame: int64(len(samples[0])), Name: "EOF", Color: audiobuf.DefaultAnchorColor}}, Regions: []audiobuf.Region{{ID: 2, Start: 0, End: 1, Name: "region", Color: "#123456"}}}})
	if err != nil {
		t.Fatal(err)
	}
	return document
}

func samples(t testing.TB, document audiobuf.Document, channel int) []float32 {
	t.Helper()
	values := make([]float32, int(document.Frames()))
	source, err := document.Channel(channel)
	if err != nil {
		t.Fatal(err)
	}
	if n := source.Read(values, 0); n != len(values) {
		t.Fatalf("read %d of %d", n, len(values))
	}
	return values
}

func assertBits(t testing.TB, got, want []float32) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("length %d, want %d", len(got), len(want))
	}
	for i := range got {
		if math.Float32bits(got[i]) != math.Float32bits(want[i]) {
			t.Fatalf("frame %d bits %08x, want %08x", i, math.Float32bits(got[i]), math.Float32bits(want[i]))
		}
	}
}

func finish(t testing.TB, builder *Builder) audiobuf.Document {
	t.Helper()
	for {
		progress, err := builder.Step(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if progress.Done {
			break
		}
	}
	result, err := builder.Result()
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestGainGoldenOwnershipAndMetadata(t *testing.T) {
	input := []float32{math.Float32frombits(0x80000000), -2, -0.5, math.Float32frombits(1), 0.25, 2, math.Float32frombits(0x7f800000), math.Float32frombits(0xff800000), math.Float32frombits(0x7fc12345), math.Float32frombits(0x7f812345)}
	for _, db := range []float64{-120, -6, 6, 60} {
		t.Run(strings.ReplaceAll(strings.TrimSpace(fmtFloat(db)), "-", "minus"), func(t *testing.T) {
			document := fixture(t, input, input)
			before := document.Metadata()
			builder, err := NewBuilder(document, ops.Range{Start: 1, End: int64(len(input)), ChannelMask: 1}, Gain{DB: db}, Limits{})
			if err != nil {
				t.Fatal(err)
			}
			result := finish(t, builder)
			dsp := make([]float64, len(input)-1)
			for i, value := range input[1:] {
				dsp[i] = float64(value)
			}
			vecmath.ScaleBlockInPlace(dsp, core.DBToLinear(db))
			want := append([]float32(nil), input...)
			for i, value := range dsp {
				want[i+1] = float32(value)
			}
			assertBits(t, samples(t, result, 0), want)
			assertBits(t, samples(t, result, 1), input)
			assertBits(t, samples(t, document, 0), input)
			if !reflect.DeepEqual(result.Metadata(), before) || !reflect.DeepEqual(document.Metadata(), before) || result.Frames() != document.Frames() || result.SampleRate() != document.SampleRate() {
				t.Fatal("process changed metadata/format/source")
			}
			peak, nonfinite := builder.Peak()
			if !nonfinite || math.IsNaN(peak) || math.IsInf(peak, 0) || peak <= 0 {
				t.Fatalf("invalid JSON-safe peak %v/%t", peak, nonfinite)
			}
			metadata := result.Metadata()
			metadata.Timeline.Markers[0].Frame = 0
			metadata.Tags["artist"] = "changed"
			if !reflect.DeepEqual(result.Metadata(), before) {
				t.Fatal("result metadata aliases accessor")
			}
		})
	}
}

func fmtFloat(value float64) string {
	return strconv.FormatFloat(value, 'g', -1, 64)
}

func TestZeroGainExactIdentityAndPeak(t *testing.T) {
	input := []float32{999, math.Float32frombits(0x7f812345), 0.5, math.Float32frombits(0x7f800000), math.Float32frombits(0x80000000)}
	document := fixture(t, input, input)
	for _, process := range []Process{Gain{}, &Gain{}} {
		builder, err := NewBuilder(document, ops.Range{End: int64(len(input)), ChannelMask: 3}, process, Limits{MaxOutputBytes: 1})
		if err != nil {
			t.Fatal("zero gain must not use materialized budget", err)
		}
		result := finish(t, builder)
		if !reflect.DeepEqual(result, document) {
			t.Fatal("identity did not return exact input document")
		}
		assertBits(t, samples(t, result, 0), input)
		if peak, nonfinite := builder.Peak(); peak != 999 || !nonfinite {
			t.Fatalf("identity peak %v/%t", peak, nonfinite)
		}
		if got, want := audiobuf.CountMemory(document, result), audiobuf.CountMemory(document); got.SampleBytes != want.SampleBytes || got.PeakBytes != want.PeakBytes || got.UniqueBlocks != want.UniqueBlocks {
			t.Fatal("identity copied samples/peaks")
		}
	}
	for _, input := range [][]float32{{0, math.Float32frombits(0x80000000)}, {math.Float32frombits(0x7f800000), math.Float32frombits(0x7fc12345)}} {
		builder, err := NewBuilder(fixture(t, input), ops.Range{End: int64(len(input)), ChannelMask: 1}, Gain{}, Limits{})
		if err != nil {
			t.Fatal(err)
		}
		finish(t, builder)
		peak, nonfinite := builder.Peak()
		if peak != 0 || nonfinite != math.IsInf(float64(input[0]), 0) {
			t.Fatalf("peak %v/%t", peak, nonfinite)
		}
	}
}

type filterProcessor struct{ section *biquad.Section }

func (p filterProcessor) ProcessBlock(block []float64) error {
	p.section.ProcessBlock(block)
	return nil
}

func TestStatefulStreamsPersistAcrossChunksAndRemainIndependent(t *testing.T) {
	const frames = audiobuf.BlockFrames + 17
	inputs := make([][]float32, 8)
	for channel := range inputs {
		inputs[channel] = make([]float32, frames+4)
		inputs[channel][2] = float32(channel + 1)
		inputs[channel][audiobuf.BlockFrames+1] = float32(channel + 2)
	}
	document := fixture(t, inputs...)
	var created []int
	coefficients := biquad.Coefficients{B0: 0.5, B1: 0.25, A1: -0.5}
	factory := processFunc(func(rate, channel int, count int64) (Processor, error) {
		if rate != 48000 || count != frames {
			t.Fatal("wrong stream metadata")
		}
		created = append(created, channel)
		return filterProcessor{section: biquad.NewSection(coefficients)}, nil
	})
	builder, err := NewBuilder(document, ops.Range{Start: 2, End: frames + 2, ChannelMask: 0x89}, factory, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(created, []int{0, 3, 7}) {
		t.Fatal("selected channel factory ordering", created)
	}
	if _, err := builder.Result(); err == nil {
		t.Fatal("premature result")
	}
	initial, err := builder.MemoryDocument()
	if err != nil || initial.Channels() != 3 || initial.Frames() != 0 {
		t.Fatal("initial partial accounting", err)
	}
	progress, err := builder.Step(context.Background())
	if err != nil || progress != (Progress{FramesDone: audiobuf.BlockFrames, FramesTotal: frames}) {
		t.Fatal("chunk progress", progress, err)
	}
	partial, err := builder.MemoryDocument()
	if err != nil || partial.Channels() != 3 || partial.Frames() != audiobuf.BlockFrames || len(partial.Metadata().Timeline.Markers)+len(partial.Metadata().Timeline.Regions) != 0 {
		t.Fatal("packed partial accounting document", err)
	}
	if got := audiobuf.CountMemory(partial); got.SampleBytes != 3*audiobuf.BlockFrames*4 || got.UniqueBlocks != 3 {
		t.Fatal("partial memory", got)
	}
	result := finish(t, builder)
	for channel := range inputs {
		want := append([]float32(nil), inputs[channel]...)
		if (0x89 & (1 << channel)) != 0 {
			dsp := make([]float64, frames)
			for frame, value := range inputs[channel][2 : frames+2] {
				dsp[frame] = float64(value)
			}
			biquad.NewSection(coefficients).ProcessBlock(dsp)
			for frame, value := range dsp {
				want[frame+2] = float32(value)
			}
		}
		assertBits(t, samples(t, result, channel), want)
		assertBits(t, samples(t, document, channel), inputs[channel])
	}
	if !reflect.DeepEqual(result.Metadata(), document.Metadata()) {
		t.Fatal("stateful process changed anchors")
	}
	if final, err := builder.MemoryDocument(); err != nil || !reflect.DeepEqual(final, result) {
		t.Fatal("completed memory document", err)
	}
	if progress, err := builder.Step(context.Background()); err != nil || !progress.Done || progress.FramesDone != frames {
		t.Fatal("completed Step not idempotent", err)
	}
}

func TestSharingAlignedOutsideAndUntouchedChannels(t *testing.T) {
	input := make([]float32, 3*audiobuf.BlockFrames+13)
	for i := range input {
		input[i] = float32(i % 17)
	}
	document := fixture(t, input, input)
	builder, err := NewBuilder(document, ops.Range{Start: audiobuf.BlockFrames, End: 2 * audiobuf.BlockFrames, ChannelMask: 1}, Gain{DB: -6}, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	result := finish(t, builder)
	old, shared := audiobuf.CountMemory(document), audiobuf.CountMemory(document, result)
	if shared.SampleBytes-old.SampleBytes != audiobuf.BlockFrames*4 || shared.UniqueBlocks-old.UniqueBlocks != 1 {
		t.Fatal("processing copied unchanged blocks", old, shared)
	}
	before, _ := document.Channel(1)
	after, _ := result.Channel(1)
	if !reflect.DeepEqual(before, after) {
		t.Fatal("unselected channel list not retained")
	}
}

func TestErrorsCancellationAndResultGuards(t *testing.T) {
	input := make([]float32, audiobuf.BlockFrames+7)
	document := fixture(t, input, input)
	sentinel := errors.New("DSP failed")
	for _, kind := range []string{"factory error", "factory nil", "factory panic", "processing error", "processing panic", "context before", "context during", "nil context", "explicit cancel"} {
		t.Run(kind, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			factory := processFunc(func(_, _ int, _ int64) (Processor, error) {
				if kind == "factory error" {
					return nil, sentinel
				}
				if kind == "factory nil" {
					return nil, nil
				}
				if kind == "factory panic" {
					panic("factory failed")
				}
				calls := 0
				return processorFunc(func(block []float64) error {
					calls++
					if kind == "context during" {
						cancel()
					}
					if calls == 2 {
						if kind == "processing error" {
							block[0] = 123
							return sentinel
						}
						if kind == "processing panic" {
							panic("processing failed")
						}
					}
					return nil
				}), nil
			})
			builder, err := NewBuilder(document, ops.Range{End: int64(len(input)), ChannelMask: 3}, factory, Limits{})
			if strings.HasPrefix(kind, "factory") {
				if err == nil {
					t.Fatal("factory failure accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if kind == "context before" {
				cancel()
			}
			if kind == "nil context" {
				ctx = nil
			}
			if kind == "explicit cancel" {
				builder.Cancel()
			}
			progress, err := builder.Step(ctx)
			if kind == "processing error" || kind == "processing panic" {
				if err != nil || progress.Done {
					t.Fatal("first chunk failed", err)
				}
				progress, err = builder.Step(ctx)
			}
			if err == nil || progress.Done {
				t.Fatal("terminal failure not reported", progress, err)
			}
			if kind == "processing error" && !errors.Is(err, sentinel) {
				t.Fatal("DSP cause lost", err)
			}
			if strings.HasPrefix(kind, "context") || kind == "explicit cancel" {
				if !errors.Is(err, context.Canceled) {
					t.Fatal("cancellation cause lost", err)
				}
			}
			if _, err := builder.Result(); err == nil {
				t.Fatal("failed result published")
			}
			if _, err := builder.MemoryDocument(); err == nil {
				t.Fatal("failed output retained")
			}
			if builder.blocks != nil || builder.channels != nil || builder.mono != nil || builder.dsp != nil || builder.document.Channels() != 0 {
				t.Fatal("failure retained partial storage")
			}
			builder.Cancel()
			assertBits(t, samples(t, document, 0), input)
		})
	}
	builder, err := NewBuilder(document, ops.Range{End: 1, ChannelMask: 1}, Gain{DB: 6}, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	result := finish(t, builder)
	builder.Cancel()
	if _, err := builder.Result(); !errors.Is(err, context.Canceled) {
		t.Fatal("cancel did not invalidate completed result", err)
	}
	if result.Frames() != document.Frames() {
		t.Fatal("cancel invalidated independently returned value")
	}
}

func TestValidationPrecedesFactoryAndAllocation(t *testing.T) {
	document := fixture(t, []float32{1, 2}, []float32{1, 2})
	called := 0
	factory := processFunc(func(_, _ int, _ int64) (Processor, error) {
		called++
		return processorFunc(func([]float64) error { return nil }), nil
	})
	for _, tt := range []struct {
		document audiobuf.Document
		selected ops.Range
		limits   Limits
		process  Process
	}{
		{audiobuf.Document{}, ops.Range{End: 1, ChannelMask: 1}, Limits{}, factory},
		{document, ops.Range{Start: -1, End: 1, ChannelMask: 1}, Limits{}, factory},
		{document, ops.Range{End: 0, ChannelMask: 1}, Limits{}, factory},
		{document, ops.Range{Start: 2, End: 1, ChannelMask: 1}, Limits{}, factory},
		{document, ops.Range{End: 3, ChannelMask: 1}, Limits{}, factory},
		{document, ops.Range{End: 1, ChannelMask: 0}, Limits{}, factory},
		{document, ops.Range{End: 1, ChannelMask: 4}, Limits{}, factory},
		{document, ops.Range{End: 1, ChannelMask: 1}, Limits{MaxOutputBytes: -1}, factory},
		{document, ops.Range{End: 1, ChannelMask: 1}, Limits{MaxOutputBytes: DefaultMaxOutputBytes + 1}, factory},
		{document, ops.Range{End: 2, ChannelMask: 3}, Limits{MaxOutputBytes: 15}, factory},
		{document, ops.Range{End: 1, ChannelMask: 1}, Limits{}, nil},
	} {
		if _, err := NewBuilder(tt.document, tt.selected, tt.process, tt.limits); err == nil {
			t.Fatal("invalid builder accepted", tt)
		}
	}
	if called != 0 {
		t.Fatal("factory ran before validation", called)
	}
	for _, db := range []float64{math.NaN(), math.Inf(1), math.Inf(-1), -121, 61} {
		if _, err := NewBuilder(document, ops.Range{End: 1, ChannelMask: 1}, Gain{DB: db}, Limits{}); err == nil {
			t.Fatal("invalid gain accepted", db)
		}
	}
	// Cheap logical duration uses repeated immutable silence blocks, not a
	// duration-sized fixture allocation. Reject before any DSP factory/scratch.
	zero, err := audiobuf.NewSilence(DefaultMaxOutputBytes/4 + 1)
	if err != nil {
		t.Fatal(err)
	}
	huge, err := audiobuf.NewDocument([]audiobuf.Channel{zero}, 48000, audiobuf.Metadata{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewBuilder(huge, ops.Range{End: huge.Frames(), ChannelMask: 1}, factory, Limits{}); err == nil || !strings.Contains(err.Error(), "budget") || called != 0 {
		t.Fatal("oversized materialization reached factory", err, called)
	}
	if _, err := NewBuilder(document, ops.Range{End: 2, ChannelMask: 3}, factory, Limits{MaxOutputBytes: 16}); err != nil {
		t.Fatal("exact budget boundary rejected", err)
	}
}

func TestLongFrameOffsets(t *testing.T) {
	const frames int64 = 1<<31 + 17
	zero, err := audiobuf.NewSilence(frames)
	if err != nil {
		t.Fatal(err)
	}
	document, err := audiobuf.NewDocument([]audiobuf.Channel{zero}, 48000, audiobuf.Metadata{Timeline: audiobuf.Timeline{NextID: 2, Markers: []audiobuf.Marker{{ID: 1, Frame: frames, Name: "EOF", Color: audiobuf.DefaultAnchorColor}}}})
	if err != nil {
		t.Fatal(err)
	}
	builder, err := NewBuilder(document, ops.Range{Start: frames - 3, End: frames, ChannelMask: 1}, Gain{DB: 6}, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	result := finish(t, builder)
	if result.Frames() != frames || !reflect.DeepEqual(result.Metadata(), document.Metadata()) {
		t.Fatal("long position/metadata truncated")
	}
	channel, _ := result.Channel(0)
	values := []float32{99, 99, 99}
	if channel.Read(values, frames-3) != 3 || !reflect.DeepEqual(values, []float32{0, 0, 0}) {
		t.Fatal("long tail wrong", values)
	}
}

// The benchmark has exact ten-minute, 48k stereo geometry; immutable full
// source blocks repeat to avoid allocating the source's 230MB fixture twice.
// Processing nevertheless materializes every selected output sample/peak.
func BenchmarkGainTenMinuteStereo(b *testing.B) {
	const frames int64 = 48000 * 600
	values := make([]float32, audiobuf.BlockFrames)
	for i := range values {
		values[i] = float32(i%97) / 128
	}
	block, err := audiobuf.NewBlock(values)
	if err != nil {
		b.Fatal(err)
	}
	blocks := make([]*audiobuf.Block, 0, int(frames/audiobuf.BlockFrames+1))
	for remaining := frames; remaining > 0; remaining -= int64(min(int64(audiobuf.BlockFrames), remaining)) {
		part := block
		if remaining < audiobuf.BlockFrames {
			part, err = audiobuf.NewBlock(values[:int(remaining)])
			if err != nil {
				b.Fatal(err)
			}
		}
		blocks = append(blocks, part)
	}
	channel, err := audiobuf.NewChannelFromBlocks(blocks)
	if err != nil {
		b.Fatal(err)
	}
	document, err := audiobuf.NewDocument([]audiobuf.Channel{channel, channel}, 48000, audiobuf.Metadata{})
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.SetBytes(frames * 2 * 4)
	b.ResetTimer()
	for range b.N {
		builder, err := NewBuilder(document, ops.Range{End: frames, ChannelMask: 3}, Gain{DB: -6}, Limits{})
		if err != nil {
			b.Fatal(err)
		}
		result := finish(b, builder)
		if result.Frames() != frames {
			b.Fatal("wrong benchmark duration")
		}
	}
}
