package history

import (
	"math"
	"reflect"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
)

const (
	hourFrames       = 48000 * 3600
	uniqueHourBlocks = 64 // per channel, not the two-block structural benchmark
	hourEdits        = 100
)

func hourValue(channel, block, frame int) float32 {
	return float32(1 + channel*1000 + block*7 + frame%257)
}

// The document has actual one-hour stereo geometry. Its 128 distinct full
// blocks plus real tail blocks retain about 34 MiB, reused across the remaining
// block references. This is NOT a fully distinct 1.4 GiB audio allocation.
func hourSnapshot(t testing.TB) snapshot {
	t.Helper()
	channels := make([]audiobuf.Channel, 2)
	for channel := range channels {
		originals := make([]*audiobuf.Block, uniqueHourBlocks)
		scratch := make([]float32, audiobuf.BlockFrames)
		for block := range originals {
			for frame := range scratch {
				scratch[frame] = hourValue(channel, block, frame)
			}
			var err error
			originals[block], err = audiobuf.NewBlock(scratch)
			if err != nil {
				t.Fatal(err)
			}
		}
		count := (hourFrames + audiobuf.BlockFrames - 1) / audiobuf.BlockFrames
		blocks := make([]*audiobuf.Block, count)
		for i := range blocks {
			blocks[i] = originals[i%len(originals)]
		}
		if tail := hourFrames % audiobuf.BlockFrames; tail != 0 {
			for frame := range scratch[:tail] {
				scratch[frame] = hourValue(channel, (count-1)%uniqueHourBlocks, frame)
			}
			var err error
			blocks[len(blocks)-1], err = audiobuf.NewBlock(scratch[:tail])
			if err != nil {
				t.Fatal(err)
			}
		}
		var err error
		channels[channel], err = audiobuf.NewChannelFromBlocks(blocks)
		if err != nil {
			t.Fatal(err)
		}
	}
	doc, err := audiobuf.NewDocument(channels, 48000, audiobuf.Metadata{Name: "one-hour"})
	if err != nil {
		t.Fatal(err)
	}
	return snapshot{document: doc}
}

func buildHourHistory(t testing.TB) (*History[snapshot], []snapshot, int64) {
	t.Helper()
	initial := hourSnapshot(t)
	baseBytes := bytesOf(initial.document)
	h := newHistory(t, initial, Limits{MaxEntries: hourEdits, MaxBytes: 2 * baseBytes})
	expected := make([]snapshot, hourEdits+1)
	expected[0] = initial
	for i := range hourEdits {
		before := h.Current().Value
		start := int64(i*audiobuf.BlockFrames + 127)
		result, err := (ops.Mute{Range: ops.Range{Start: start, End: start + 1, ChannelMask: 1}}).Apply(before.document)
		if err != nil {
			t.Fatal(err)
		}
		after := snapshot{document: result, selection: start, anchor: "retained anchor"}
		if err := h.Push("Mute one frame", before, after); err != nil {
			t.Fatalf("push %d: %v", i, err)
		}
		expected[i+1] = after
	}
	return h, expected, baseBytes
}

// Compare immutable full snapshots (including complete channel/block geometry)
// by value/identity, then check every edited occurrence against its bit oracle.
// This avoids scanning 1.4 GiB 201 times merely to prove identity restoration.
func assertHourState(t testing.TB, value, expected snapshot, edits int) {
	t.Helper()
	if !reflect.DeepEqual(value, expected) || value.document.Frames() != hourFrames || value.document.Channels() != 2 {
		t.Fatal("navigation did not restore the exact full snapshot")
	}
	for channelIndex := range value.document.Channels() {
		channel, err := value.document.Channel(channelIndex)
		if err != nil {
			t.Fatal(err)
		}
		for block := range hourEdits {
			got := [3]float32{}
			start := int64(block*audiobuf.BlockFrames + 126)
			if channel.Read(got[:], start) != len(got) {
				t.Fatal("short history sample read")
			}
			for i, sample := range got {
				want := hourValue(channelIndex, block%uniqueHourBlocks, 126+i)
				if channelIndex == 0 && block < edits && i == 1 {
					want = 0
				}
				if math.Float32bits(sample) != math.Float32bits(want) {
					t.Fatalf("state with %d edits channel %d block %d local frame %d bits %08x, want %08x", edits, channelIndex, block, 126+i, math.Float32bits(sample), math.Float32bits(want))
				}
			}
		}
	}
}

func TestHundredStepsHourMemoryAndExactUndoRedo(t *testing.T) {
	h, expected, baseBytes := buildHourHistory(t)
	stats := audiobuf.CountMemory(expected[0].document)
	if stats.UniqueBlocks != 2*uniqueHourBlocks+2 || baseBytes < 32<<20 || len(h.Entries()) != hourEdits || len(h.States()) != hourEdits+1 {
		t.Fatalf("fixture or command count invalid: source %+v, entries %d", stats, len(h.Entries()))
	}
	retained := bytesOf(h.Documents()...)
	if retained != h.RetainedBytes() || retained >= 2*baseBytes {
		t.Fatalf("100-history memory %d bytes is not below twice source %d bytes", retained, baseBytes)
	}
	t.Logf("one-hour 48k stereo: %d distinct original blocks; source unique samples+peaks=%d bytes; 100-command/101-state history=%d bytes; ratio=%.6f; repeated immutable blocks only after first64/channel", stats.UniqueBlocks, baseBytes, retained, float64(retained)/float64(baseBytes))
	assertHourState(t, h.Current().Value, expected[hourEdits], hourEdits)
	ids := h.States()
	for i := hourEdits - 1; i >= 0; i-- {
		value, err := h.Undo()
		if err != nil || h.CurrentID() != ids[i].ID {
			t.Fatalf("undo %d: %v", i, err)
		}
		assertHourState(t, value, expected[i], i)
	}
	if h.CanUndo() || h.Dirty() {
		t.Fatal("initial saved state not restored after all100 undos")
	}
	for i := 1; i <= hourEdits; i++ {
		value, err := h.Redo()
		if err != nil || h.CurrentID() != ids[i].ID {
			t.Fatalf("redo %d: %v", i, err)
		}
		assertHourState(t, value, expected[i], i)
	}
	if h.CanRedo() || !h.Dirty() || h.RetainedBytes() != retained {
		t.Fatal("navigation changed retained memory or dirty/end state")
	}
	// Check every frame of each distinct original full block and the real tail.
	// They back the complete source hour, proving edits never mutated its audio.
	for channelIndex := range expected[0].document.Channels() {
		channel, err := expected[0].document.Channel(channelIndex)
		if err != nil {
			t.Fatal(err)
		}
		got := make([]float32, audiobuf.BlockFrames)
		for block := range uniqueHourBlocks + 1 {
			start, original := int64(block*audiobuf.BlockFrames), block
			if block == uniqueHourBlocks {
				start = hourFrames / audiobuf.BlockFrames * audiobuf.BlockFrames
				original = (hourFrames / audiobuf.BlockFrames) % uniqueHourBlocks
			}
			count := channel.Read(got, start)
			for frame, sample := range got[:count] {
				want := hourValue(channelIndex, original, frame)
				if math.Float32bits(sample) != math.Float32bits(want) {
					t.Fatalf("original source mutation channel %d block %d frame %d", channelIndex, original, frame)
				}
			}
		}
	}
}

// Benchmark includes both structural cut/paste and atomic history accounting
// at100 retained commands. Fixture/history construction is outside the timer.
func BenchmarkHistoryCutPasteHourStereoAtCapacity(b *testing.B) {
	baseline, _, _ := buildHourHistory(b)
	selected := ops.Range{Start: 48000*1000 + 17, End: 48000*2000 + 31, ChannelMask: 3}
	b.ReportAllocs()
	for b.Loop() {
		h := baseline.Clone()
		before := h.Current().Value
		clip, err := ops.NewClipboard(before.document, selected)
		if err != nil {
			b.Fatal(err)
		}
		cut, err := (ops.Delete{Range: selected}).Apply(before.document)
		if err != nil {
			b.Fatal(err)
		}
		cutState := snapshot{document: cut}
		if err := h.Push("Cut", before, cutState); err != nil {
			b.Fatal(err)
		}
		result, err := (ops.Paste{Range: ops.Range{Start: selected.Start, End: selected.Start, ChannelMask: 3}, Clipboard: clip, Mode: ops.PasteInsert}).Apply(cut)
		if err != nil {
			b.Fatal(err)
		}
		if err := h.Push("Paste", cutState, snapshot{document: result}); err != nil {
			b.Fatal(err)
		}
		if result.Frames() != hourFrames || len(h.Entries()) != hourEdits {
			b.Fatal("cut/paste history lost full geometry or count")
		}
	}
}
