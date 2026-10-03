package ops

import (
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
)

func document(t testing.TB, samples ...[]float32) audiobuf.Document {
	t.Helper()
	channels := make([]audiobuf.Channel, len(samples))
	for i, values := range samples {
		channels[i] = audiobuf.NewChannel(values)
	}
	doc, err := audiobuf.NewDocument(channels, 48000, audiobuf.Metadata{Name: "source", Tags: map[string]string{"artist": "original"}})
	if err != nil {
		t.Fatal(err)
	}
	return doc
}

func readDocument(t testing.TB, doc audiobuf.Document) [][]float32 {
	t.Helper()
	samples := make([][]float32, doc.Channels())
	for i := range samples {
		channel, err := doc.Channel(i)
		if err != nil {
			t.Fatal(err)
		}
		samples[i] = make([]float32, int(doc.Frames()))
		if n := channel.Read(samples[i], 0); n != len(samples[i]) {
			t.Fatalf("channel %d read %d of %d", i, n, len(samples[i]))
		}
	}
	return samples
}

func assertSamples(t testing.TB, doc audiobuf.Document, want [][]float32) {
	t.Helper()
	got := readDocument(t, doc)
	if len(got) != len(want) {
		t.Fatalf("channels %d, want %d", len(got), len(want))
	}
	for channel := range got {
		if len(got[channel]) != len(want[channel]) {
			t.Fatalf("channel %d frames %d, want %d", channel, len(got[channel]), len(want[channel]))
		}
		for frame := range got[channel] {
			if math.Float32bits(got[channel][frame]) != math.Float32bits(want[channel][frame]) {
				t.Fatalf("channel %d frame %d = %08x (%v), want %08x (%v)", channel, frame, math.Float32bits(got[channel][frame]), got[channel][frame], math.Float32bits(want[channel][frame]), want[channel][frame])
			}
		}
	}
}

func TestOperationGolden(t *testing.T) {
	source := document(t, []float32{1, 2, 3, 4, 5}, []float32{11, 12, 13, 14, 15})
	clipboard, err := NewClipboard(document(t, []float32{20, 30}), Range{End: 2, ChannelMask: 1})
	if err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		name string
		op   Operation
		want [][]float32
	}{
		{"delete all", Delete{Range{1, 3, 3}}, [][]float32{{1, 4, 5}, {11, 14, 15}}},
		{"delete subset", Delete{Range{1, 3, 1}}, [][]float32{{1, 4, 5, 0, 0}, {11, 12, 13, 14, 15}}},
		{"delete everything", Delete{Range{0, 5, 3}}, [][]float32{{}, {}}},
		{"crop all time", Crop{Range{1, 4, 1}}, [][]float32{{2, 3, 4}, {12, 13, 14}}},
		{"silence all", InsertSilence{Range{2, 4, 3}, 2}, [][]float32{{1, 2, 0, 0, 3, 4, 5}, {11, 12, 0, 0, 13, 14, 15}}},
		{"silence subset", InsertSilence{Range{2, 4, 1}, 2}, [][]float32{{1, 2, 0, 0, 3, 4, 5}, {11, 12, 13, 14, 15, 0, 0}}},
		{"mute subset", Mute{Range{1, 4, 1}}, [][]float32{{1, 0, 0, 0, 5}, {11, 12, 13, 14, 15}}},
		{"duplicate subset", Duplicate{Range{1, 3, 1}}, [][]float32{{1, 2, 3, 2, 3, 4, 5}, {11, 12, 13, 14, 15, 0, 0}}},
		{"swap range", SwapChannels{Range{1, 4, 3}}, [][]float32{{1, 12, 13, 14, 5}, {11, 2, 3, 4, 15}}},
		{"swap cursor whole file", SwapChannels{Range{2, 2, 3}}, [][]float32{{11, 12, 13, 14, 15}, {1, 2, 3, 4, 5}}},
		{"paste mono insert all", Paste{Range{2, 4, 3}, clipboard, PasteInsert}, [][]float32{{1, 2, 20, 30, 3, 4, 5}, {11, 12, 20, 30, 13, 14, 15}}},
		{"paste replace subset", Paste{Range{1, 4, 1}, clipboard, PasteReplace}, [][]float32{{1, 20, 30, 5, 0}, {11, 12, 13, 14, 15}}},
		{"paste replace all", Paste{Range{1, 4, 3}, clipboard, PasteReplace}, [][]float32{{1, 20, 30, 5}, {11, 20, 30, 15}}},
		{"paste mix subset extends", Paste{Range{4, 4, 1}, clipboard, PasteMix}, [][]float32{{1, 2, 3, 4, 25, 30}, {11, 12, 13, 14, 15, 0}}},
		{"paste mix ignores end", Paste{Range{1, 5, 1}, clipboard, PasteMix}, [][]float32{{1, 22, 33, 4, 5}, {11, 12, 13, 14, 15}}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			before := readDocument(t, source)
			result, err := tt.op.Apply(source)
			if err != nil {
				t.Fatal(err)
			}
			assertSamples(t, result, tt.want)
			assertSamples(t, source, before)
			if result.SampleRate() != source.SampleRate() || !reflect.DeepEqual(result.Metadata(), source.Metadata()) {
				t.Fatal("edit changed rate or metadata")
			}
		})
	}
}

func TestClipboardPackedChannelsAndOwnership(t *testing.T) {
	values := make([][]float32, 8)
	for i := range values {
		values[i] = []float32{float32(i), float32(i + 10), float32(i + 20)}
	}
	source := document(t, values...)
	clipboard, err := Copy(source, Range{Start: 1, End: 3, ChannelMask: 0x89})
	if err != nil || clipboard.Channels() != 3 || clipboard.Frames() != 2 || clipboard.SampleRate() != 48000 {
		t.Fatalf("clipboard format %d/%d/%d, error %v", clipboard.SampleRate(), clipboard.Channels(), clipboard.Frames(), err)
	}
	for packed, sourceChannel := range []int{0, 3, 7} {
		got := []float32{99, 99, 99}
		if n := clipboard.Read(got, packed, 0); n != 2 || got[0] != float32(sourceChannel+10) || got[1] != float32(sourceChannel+20) || got[2] != 99 {
			t.Fatalf("packed channel %d: %v", packed, got)
		}
		window, err := clipboard.Window(packed)
		if err != nil || window.Frames() != 2 {
			t.Fatal("invalid clipboard window", err)
		}
	}
	for _, channel := range []int{-1, 3} {
		if _, err := clipboard.Window(channel); err == nil || clipboard.Read(make([]float32, 2), channel, 0) != 0 {
			t.Fatal("invalid clipboard channel accepted")
		}
	}
	windows := clipboard.Windows()
	windows[0] = audiobuf.Window{}
	if clipboard.Frames() != 2 {
		t.Fatal("window list aliases clipboard")
	}
	stats := audiobuf.CountMemoryWithWindows([]audiobuf.Document{source}, clipboard.Windows()...)
	if stats.UniqueBlocks != 8 || stats.BlockReferences != 11 || stats.SampleBytes != 8*3*4 {
		t.Fatalf("clipboard copied audio storage %+v", stats)
	}
	// Three packed source channels map to exactly the selected target bits.
	result, err := (Paste{Range{Start: 1, End: 2, ChannelMask: 0x52}, clipboard, PasteReplace}).Apply(source)
	if err != nil {
		t.Fatal(err)
	}
	want := readDocument(t, source)
	for packed, target := range []int{1, 4, 6} {
		src := []int{0, 3, 7}[packed]
		want[target] = []float32{float32(target), float32(src + 10), float32(src + 20), float32(target + 20)}
	}
	for _, target := range []int{0, 2, 3, 5, 7} {
		want[target] = append(want[target], 0)
	}
	assertSamples(t, result, want)
}

func TestOperationErrorsAreAtomic(t *testing.T) {
	source := document(t, []float32{1, 2, 3}, []float32{4, 5, 6})
	clip, err := NewClipboard(source, Range{End: 2, ChannelMask: 3})
	if err != nil {
		t.Fatal(err)
	}
	for _, selected := range []Range{{-1, 1, 3}, {2, 1, 3}, {0, 4, 3}, {0, 1, 0}, {0, 1, -1}, {0, 1, 4}, {0, math.MaxInt64, 3}} {
		for _, op := range []Operation{Delete{selected}, Crop{selected}, Mute{selected}, Duplicate{selected}, SwapChannels{selected}, InsertSilence{selected, 1}, Paste{selected, clip, PasteInsert}} {
			result, err := op.Apply(source)
			if err == nil || !reflect.DeepEqual(result, source) {
				t.Fatalf("%T invalid range %+v not atomic, error %v", op, selected, err)
			}
		}
		if _, err := NewClipboard(source, selected); err == nil {
			t.Fatal("invalid clipboard selection accepted", selected)
		}
	}
	for _, op := range []Operation{
		Delete{Range{1, 1, 3}},
		Crop{Range{1, 1, 3}},
		Mute{Range{1, 1, 3}},
		Duplicate{Range{1, 1, 3}},
		SwapChannels{Range{0, 3, 1}},
		InsertSilence{Range{0, 0, 3}, 0},
		InsertSilence{Range{0, 0, 3}, -1},
		InsertSilence{Range{0, 0, 3}, math.MaxInt64},
		InsertSilence{Range{0, 0, 3}, maxSafeFrames - 3},
		Paste{Range{0, 1, 3}, Clipboard{}, PasteInsert},
		Paste{Range{0, 1, 3}, clip, "bad"},
		Paste{Range{0, 1, 1}, clip, PasteInsert},
	} {
		result, err := op.Apply(source)
		if err == nil || !reflect.DeepEqual(result, source) {
			t.Fatalf("invalid %T not atomic: %v", op, err)
		}
	}
	channels := []audiobuf.Channel{}
	for i := range source.Channels() {
		channel, err := source.Channel(i)
		if err != nil {
			t.Fatal(err)
		}
		channels = append(channels, channel)
	}
	otherRate, err := audiobuf.NewDocument(channels, 44100, source.Metadata())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := (Paste{Range{0, 0, 3}, clip, PasteInsert}).Apply(otherRate); err == nil {
		t.Fatal("rate mismatch accepted without conversion")
	}
	if _, err := NewClipboard(source, Range{1, 1, 3}); err == nil {
		t.Fatal("empty copy accepted")
	}
	if result, err := (Delete{Range{0, 1, 1}}).Apply(audiobuf.Document{}); err == nil || result.Channels() != 0 {
		t.Fatal("missing document accepted")
	}
}

func TestStructuralEditsPreserveSpecialFloatBits(t *testing.T) {
	values := []float32{}
	for _, bits := range []uint32{0x80000000, 0x7f801234, 0x7fc01234, 0xffc01234, 1, 0x80000001, 0x7f800000, 0xff800000} {
		values = append(values, math.Float32frombits(bits))
	}
	source := document(t, values)
	clip, err := NewClipboard(source, Range{1, 7, 1})
	if err != nil {
		t.Fatal(err)
	}
	cut, err := (Delete{Range{1, 7, 1}}).Apply(source)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := (Paste{Range{1, 1, 1}, clip, PasteInsert}).Apply(cut)
	if err != nil {
		t.Fatal(err)
	}
	assertSamples(t, restored, [][]float32{values})
	assertSamples(t, source, [][]float32{values})
}

func TestPasteMixUsesUnclippedIEEEArithmetic(t *testing.T) {
	source := document(t, []float32{0.75, float32(math.Inf(1)), float32(math.NaN()), 0})
	clip, err := NewClipboard(document(t, []float32{0.75, float32(math.Inf(-1)), 1, 2}), Range{0, 4, 1})
	if err != nil {
		t.Fatal(err)
	}
	result, err := (Paste{Range{0, 0, 1}, clip, PasteMix}).Apply(source)
	if err != nil {
		t.Fatal(err)
	}
	got := readDocument(t, result)[0]
	if got[0] != 1.5 || !math.IsNaN(float64(got[1])) || !math.IsNaN(float64(got[2])) || got[3] != 2 {
		t.Fatalf("mix clipped or changed IEEE behavior %v", got)
	}
}

// Large fixtures reuse immutable blocks, but have the actual requested duration
// and full block-list traversal; no duration-sized sample allocation is needed.
func largeDocument(t testing.TB, frames int64, channels int) audiobuf.Document {
	t.Helper()
	result := make([]audiobuf.Channel, channels)
	for channel := range channels {
		samples := make([]float32, audiobuf.BlockFrames)
		for i := range samples {
			samples[i] = float32(i%257 + channel*300)
		}
		full, err := audiobuf.NewBlock(samples)
		if err != nil {
			t.Fatal(err)
		}
		count := int((frames + audiobuf.BlockFrames - 1) / audiobuf.BlockFrames)
		blocks := make([]*audiobuf.Block, count)
		for i := range blocks {
			blocks[i] = full
		}
		if tail := int(frames % audiobuf.BlockFrames); tail != 0 {
			blocks[len(blocks)-1], err = audiobuf.NewBlock(samples[:tail])
			if err != nil {
				t.Fatal(err)
			}
		}
		result[channel], err = audiobuf.NewChannelFromBlocks(blocks)
		if err != nil {
			t.Fatal(err)
		}
	}
	doc, err := audiobuf.NewDocument(result, 48000, audiobuf.Metadata{})
	if err != nil {
		t.Fatal(err)
	}
	return doc
}

func TestOneHourCutPasteSharesWholeBlocks(t *testing.T) {
	source := largeDocument(t, 48000*3600, 2)
	selected := Range{48000*1000 + 17, 48000*2000 + 31, 3}
	clipboard, err := NewClipboard(source, selected)
	if err != nil {
		t.Fatal(err)
	}
	before := audiobuf.CountMemory(source)
	withCopy := audiobuf.CountMemoryWithWindows([]audiobuf.Document{source}, clipboard.Windows()...)
	if withCopy.SampleBytes != before.SampleBytes || withCopy.PeakBytes != before.PeakBytes || withCopy.UniqueBlocks != before.UniqueBlocks {
		t.Fatalf("unaligned clipboard copied original samples or peaks: %+v -> %+v", before, withCopy)
	}
	cut, err := (Delete{selected}).Apply(source)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := (Paste{Range{selected.Start, selected.Start, 3}, clipboard, PasteInsert}).Apply(cut)
	if err != nil || restored.Frames() != source.Frames() {
		t.Fatalf("restore duration %d, error %v", restored.Frames(), err)
	}
	combined := audiobuf.CountMemoryWithWindows([]audiobuf.Document{source, cut, restored}, clipboard.Windows()...)
	if combined.UniqueBlocks > before.UniqueBlocks+12 || combined.SampleBytes > before.SampleBytes+12*audiobuf.BlockFrames*4 {
		t.Fatalf("edit copied whole-file storage %+v", combined)
	}
	for _, start := range []int64{0, selected.Start - 1, selected.Start, selected.End - 1, selected.End, source.Frames() - 1} {
		for i := range source.Channels() {
			a, err := source.Channel(i)
			if err != nil {
				t.Fatal(err)
			}
			b, err := restored.Channel(i)
			if err != nil {
				t.Fatal(err)
			}
			want, got := make([]float32, 2), make([]float32, 2)
			if a.Read(want, start) != b.Read(got, start) || !reflect.DeepEqual(want, got) {
				t.Fatalf("restore mismatch at channel %d frame %d: %v vs %v", i, start, got, want)
			}
		}
	}
}

func TestOperationsBeyondInt32(t *testing.T) {
	source := largeDocument(t, 1<<31+2*audiobuf.BlockFrames, 2)
	selected := Range{1<<31 + 7, 1<<31 + 12, 1}
	cut, err := (Delete{selected}).Apply(source)
	if err != nil || cut.Frames() != source.Frames() {
		t.Fatalf("long subset delete: %v", err)
	}
	clip, err := NewClipboard(source, selected)
	if err != nil || clip.Frames() != 5 {
		t.Fatalf("long clipboard: %v", err)
	}
	inserted, err := (Paste{Range{selected.Start, selected.Start, 1}, clip, PasteInsert}).Apply(source)
	if err != nil || inserted.Frames() != source.Frames()+5 {
		t.Fatalf("long insert duration: %v", err)
	}
	for i := range source.Channels() {
		channel, err := inserted.Channel(i)
		if err != nil {
			t.Fatal(err)
		}
		got := make([]float32, 5)
		if channel.Read(got, selected.Start) != 5 {
			t.Fatal("long read failed")
		}
		for frame, value := range got {
			if value != float32(7+frame+i*300) {
				t.Fatalf("long channel %d frame %d value %v", i, frame, value)
			}
		}
	}
}

func BenchmarkCutPasteHourStereo(b *testing.B) {
	source := largeDocument(b, 48000*3600, 2)
	selected := Range{48000*1000 + 17, 48000*2000 + 31, 3}
	b.ReportAllocs()
	for b.Loop() {
		clip, err := NewClipboard(source, selected)
		if err != nil {
			b.Fatal(err)
		}
		cut, err := (Delete{selected}).Apply(source)
		if err != nil {
			b.Fatal(err)
		}
		result, err := (Paste{Range{selected.Start, selected.Start, 3}, clip, PasteInsert}).Apply(cut)
		if err != nil || result.Frames() != source.Frames() {
			b.Fatalf("cut+paste result frames %d, error %v", result.Frames(), err)
		}
	}
}

func TestMixBudgetBoundaries(t *testing.T) {
	for channels := 1; channels <= 8; channels++ {
		limit := MaxMixOutputBytes / 4 / int64(channels)
		for _, frames := range []int64{0, limit - 1, limit} {
			if err := validateMixBudget(frames, channels); err != nil {
				t.Fatalf("valid mix budget %d frames/%d channels: %v", frames, channels, err)
			}
		}
		for _, frames := range []int64{-1, limit + 1, math.MaxInt64} {
			if err := validateMixBudget(frames, channels); err == nil || !strings.Contains(err.Error(), "materialized") || !strings.Contains(err.Error(), "budget") {
				t.Fatalf("invalid mix budget %d frames/%d channels: %v", frames, channels, err)
			}
		}
	}
	for _, channels := range []int{0, -1, 9, math.MaxInt} {
		if err := validateMixBudget(1, channels); err == nil {
			t.Fatalf("invalid mix budget channel count %d", channels)
		}
	}
}

func TestPasteMixBudgetIsAtomicAndStructuralPasteIsUnrestricted(t *testing.T) {
	// This represents over 512 MiB using about 2,049 references to one zero
	// block, not 512 MiB of samples. Do not materialize it in this regression.
	frames := MaxMixOutputBytes/4 + 1
	channel, err := audiobuf.NewSilence(frames)
	if err != nil {
		t.Fatal(err)
	}
	source, err := audiobuf.NewDocument([]audiobuf.Channel{channel, channel}, 48000, audiobuf.Metadata{Name: "shared"})
	if err != nil {
		t.Fatal(err)
	}
	clip, err := NewClipboard(source, Range{End: frames, ChannelMask: 1})
	if err != nil {
		t.Fatal(err)
	}
	before := audiobuf.CountMemoryWithWindows([]audiobuf.Document{source}, clip.Windows()...)
	for _, mask := range []int{1, 3} {
		result, err := (Paste{Range{ChannelMask: mask}, clip, PasteMix}).Apply(source)
		if err == nil || !strings.Contains(err.Error(), "materialized") || !strings.Contains(err.Error(), "budget") || !reflect.DeepEqual(result, source) {
			t.Fatalf("oversized mix was not rejected atomically: %v", err)
		}
		if after := audiobuf.CountMemoryWithWindows([]audiobuf.Document{source}, clip.Windows()...); after != before {
			t.Fatal("rejected mix changed retained storage")
		}
	}
	for _, mode := range []PasteMode{PasteInsert, PasteReplace} {
		result, err := (Paste{Range{End: frames, ChannelMask: 3}, clip, mode}).Apply(source)
		if err != nil {
			t.Fatalf("shared %s was incorrectly subject to materialized budget: %v", mode, err)
		}
		if combined := audiobuf.CountMemory(source, result); combined.UniqueBlocks != before.UniqueBlocks || combined.SampleBytes != before.SampleBytes || combined.PeakBytes != before.PeakBytes {
			t.Fatalf("structural %s materialized logical samples: %+v", mode, combined)
		}
	}
}
