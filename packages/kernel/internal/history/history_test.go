package history

import (
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
)

type snapshot struct {
	document  audiobuf.Document
	selection int64
	anchor    string
}

func snapshotDocument(value snapshot) audiobuf.Document { return value.document }

func makeSnapshot(t testing.TB, values ...float32) snapshot {
	t.Helper()
	document, err := audiobuf.NewDocument([]audiobuf.Channel{audiobuf.NewChannel(values)}, 48000, audiobuf.Metadata{Name: "source"})
	if err != nil {
		t.Fatal(err)
	}
	return snapshot{document: document}
}

func newHistory(t testing.TB, initial snapshot, limits Limits) *History[snapshot] {
	t.Helper()
	h, err := New(initial, "Opened file", limits, snapshotDocument)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func bytesOf(documents ...audiobuf.Document) int64 {
	stats := audiobuf.CountMemory(documents...)
	return stats.SampleBytes + stats.PeakBytes
}

func TestHistoryNavigationBranchAndSavePoint(t *testing.T) {
	initial := makeSnapshot(t, 1)
	h := newHistory(t, initial, Limits{MaxEntries: 100, MaxBytes: 1 << 20})
	baseID := h.CurrentID()
	if h.Dirty() || h.CanUndo() || h.CanRedo() || h.SavedID() != baseID || len(h.Entries()) != 0 || len(h.States()) != 1 || h.BaseLabel() != "Opened file" {
		t.Fatal("invalid initial history")
	}
	for i := range 3 {
		before := h.Current().Value
		before.selection, before.anchor = int64(i+1), "before"
		after := makeSnapshot(t, float32(i+2))
		after.selection, after.anchor = int64(i+10), "after"
		if err := h.Push("Edit", before, after); err != nil {
			t.Fatal(err)
		}
	}
	states := h.States()
	if len(states) != 4 || h.CurrentID() != states[3].ID || !h.Dirty() || !h.CanUndo() || h.CanRedo() {
		t.Fatal("invalid pushed history")
	}
	if err := h.MarkSaved(h.CurrentID()); err != nil || h.Dirty() {
		t.Fatal("current save point not clean", err)
	}
	if value, err := h.Undo(); err != nil || value.selection != 3 || value.anchor != "before" || !h.Dirty() {
		t.Fatalf("undo did not restore latest before metadata %+v, %v", value, err)
	}
	if value, err := h.Redo(); err != nil || value.selection != 12 || value.anchor != "after" || h.Dirty() {
		t.Fatalf("redo to saved state %+v, %v", value, err)
	}
	if _, err := h.Jump(baseID); err != nil || !h.CanRedo() || h.CanUndo() {
		t.Fatal("jump to base failed", err)
	}
	if _, err := h.Jump(states[2].ID); err != nil {
		t.Fatal(err)
	}
	oldSequence := h.sequence
	before := h.Current().Value
	before.selection = 999
	if err := h.Push("Branch", before, makeSnapshot(t, 10)); err != nil {
		t.Fatal(err)
	}
	if h.CanRedo() || len(h.Entries()) != 3 || h.sequence != oldSequence+1 || h.CurrentID() == states[3].ID || !h.Dirty() || h.SavedID() != states[3].ID {
		t.Fatal("branch reused ID, retained redo, or lost saved identity")
	}
	if _, err := h.Jump(states[3].ID); err == nil {
		t.Fatal("discarded redo state remains navigable")
	}
	if value, err := h.Undo(); err != nil || value.selection != 999 {
		t.Fatal("branch did not preserve current ID/latest before metadata", err)
	}
	if err := h.MarkSaved(h.CurrentID()); err != nil || h.Dirty() {
		t.Fatal("new save point failed", err)
	}
}

func TestHistoryStagingCloneAndReplacement(t *testing.T) {
	initial := makeSnapshot(t, 1, 2, 3)
	h := newHistory(t, initial, Limits{MaxEntries: 10, MaxBytes: 1 << 20})
	before := initial
	before.selection = 7
	staged, err := h.StagePush("Edit", before, makeSnapshot(t, 4, 5, 6))
	if err != nil || h.CanUndo() || h.Current().Value.selection != 0 || staged.CurrentID() == h.CurrentID() {
		t.Fatalf("push staging mutated source history: %v", err)
	}
	if staged.States()[0].ID != h.CurrentID() || staged.States()[0].Value.selection != 7 {
		t.Fatal("staging replaced the before state ID")
	}
	clone := staged.Clone()
	value := clone.Current().Value
	value.selection, value.anchor = 99, "latest anchor"
	id, dirty, retained := clone.CurrentID(), clone.Dirty(), clone.RetainedBytes()
	if err := clone.ReplaceCurrent(value); err != nil || clone.CurrentID() != id || clone.Dirty() != dirty || clone.RetainedBytes() != retained || staged.Current().Value.selection == 99 {
		t.Fatal("copy-on-write replacement mutated original or identity", err)
	}
	if _, err := clone.Undo(); err != nil || !staged.CanUndo() || staged.CanRedo() {
		t.Fatal("clone navigation changed source cursor", err)
	}
	if value, err := clone.Redo(); err != nil || value.anchor != "latest anchor" {
		t.Fatal("redo lost replacement metadata", err)
	}
	states := clone.States()
	states[0].ID = "changed"
	entries := clone.Entries()
	entries[0].Label, entries[0].Before.ID = "changed", "changed"
	if clone.States()[0].ID == "changed" || clone.Entries()[0].Label == "changed" {
		t.Fatal("returned lists expose mutable history slices")
	}
	if allocations := testing.AllocsPerRun(100, func() {
		if _, err := clone.Undo(); err != nil {
			panic(err)
		}
		if _, err := clone.Redo(); err != nil {
			panic(err)
		}
	}); allocations != 0 {
		t.Fatalf("history navigation allocated %v objects", allocations)
	}
}

func TestHistoryCountAndMemoryEviction(t *testing.T) {
	initial := makeSnapshot(t, 1)
	one := bytesOf(initial.document)
	for _, tt := range []struct {
		name   string
		limits Limits
	}{
		{"count", Limits{MaxEntries: 1, MaxBytes: 1 << 20}},
		{"unique bytes", Limits{MaxEntries: 100, MaxBytes: 2 * one}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			h := newHistory(t, initial, tt.limits)
			baseID := h.CurrentID()
			for i := range 3 {
				if err := h.Push("Edit", h.Current().Value, makeSnapshot(t, float32(i+2))); err != nil {
					t.Fatal(err)
				}
			}
			if len(h.Entries()) != 1 || len(h.States()) != 2 || h.BaseLabel() != "Edit" || h.RetainedBytes() != 2*one || h.SavedID() != baseID || !h.Dirty() {
				t.Fatalf("invalid eviction states %+v, bytes %d", h.States(), h.RetainedBytes())
			}
			if _, err := h.Jump(baseID); err == nil {
				t.Fatal("evicted state still navigable")
			}
			if _, err := h.Undo(); err != nil || h.CanUndo() || !h.Dirty() {
				t.Fatal("latest accepted edit not undoable", err)
			}
			if _, err := h.Redo(); err != nil {
				t.Fatal(err)
			}
			// Evicted snapshots must not survive in unused backing-array slots.
			for _, state := range h.states[len(h.states):cap(h.states)] {
				if state.Value.document.Channels() != 0 || state.ID != "" {
					t.Fatal("evicted value remains hidden in retained backing array")
				}
			}
		})
	}
}

func TestHistoryErrorsAreAtomic(t *testing.T) {
	initial := makeSnapshot(t, 1)
	for _, limits := range []Limits{{}, {MaxEntries: -1, MaxBytes: 100}, {MaxEntries: 1, MaxBytes: -1}, {MaxEntries: 1, MaxBytes: bytesOf(initial.document) - 1}} {
		if _, err := New(initial, "Initial", limits, snapshotDocument); err == nil {
			t.Fatal("invalid limits accepted", limits)
		}
	}
	if _, err := New(initial, "Initial", Limits{1, 100}, nil); err == nil {
		t.Fatal("nil document accessor accepted")
	}
	if _, err := New(initial, "  ", Limits{1, 100}, snapshotDocument); err == nil {
		t.Fatal("empty initial label accepted")
	}
	h := newHistory(t, initial, Limits{10, 3 * bytesOf(initial.document)})
	for i := range 2 {
		if err := h.Push("Edit", h.Current().Value, makeSnapshot(t, float32(i+2))); err != nil {
			t.Fatal(err)
		}
	}
	if err := h.MarkSaved(h.CurrentID()); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Undo(); err != nil {
		t.Fatal(err)
	}
	before := h.Clone()
	beforeStates, beforeEntries := h.States(), h.Entries()
	assertAtomic := func() {
		t.Helper()
		if !reflect.DeepEqual(h.States(), beforeStates) || !reflect.DeepEqual(h.Entries(), beforeEntries) || h.CurrentID() != before.CurrentID() || h.SavedID() != before.SavedID() || h.RetainedBytes() != before.RetainedBytes() || h.Limits() != before.Limits() || h.sequence != before.sequence {
			t.Fatal("rejected action changed history")
		}
	}
	huge := makeSnapshot(t, make([]float32, 100)...)
	metadata := h.Current().Value
	metadata.selection = 999
	if err := h.Push("Rejected branch", metadata, huge); err == nil || !strings.Contains(err.Error(), "budget") {
		t.Fatalf("nonundoable edit accepted: %v", err)
	}
	assertAtomic()
	if err := h.Push("", metadata, metadata); err == nil {
		t.Fatal("empty label accepted")
	}
	assertAtomic()
	if err := h.ReplaceCurrent(huge); err == nil {
		t.Fatal("over-budget replacement accepted")
	}
	assertAtomic()
	for _, limits := range []Limits{{}, {1, 1}} {
		if err := h.SetLimits(limits); err == nil {
			t.Fatal("invalid/nonundoable limit accepted", limits)
		}
		assertAtomic()
	}
	if _, err := h.Jump("missing"); err == nil {
		t.Fatal("unknown jump accepted")
	}
	assertAtomic()
	if err := h.MarkSaved(h.States()[0].ID); err == nil {
		t.Fatal("noncurrent save ID accepted")
	}
	assertAtomic()
	h.sequence = math.MaxUint64
	if err := h.Push("Exhausted", metadata, metadata); err == nil || h.sequence != math.MaxUint64 || !reflect.DeepEqual(h.States(), beforeStates) {
		t.Fatal("exhausted IDs not rejected atomically", err)
	}
	base := newHistory(t, initial, Limits{10, 1 << 20})
	if _, err := base.Undo(); err == nil {
		t.Fatal("undo at base accepted")
	}
	if _, err := base.Redo(); err == nil {
		t.Fatal("redo at end accepted")
	}
}

func TestSetLimitsOldestThenFarthestRedo(t *testing.T) {
	for _, tt := range []struct {
		name    string
		cursor  int
		limits  Limits
		wantIDs []int
	}{
		{"oldest first count", 3, Limits{2, 1 << 20}, []int{3, 4, 5}},
		{"oldest then far redo bytes", 3, Limits{100, 104}, []int{3, 4}},
		{"base preserves nearest redo", 0, Limits{1, 1 << 20}, []int{1, 2}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			h := newHistory(t, makeSnapshot(t, 1), Limits{100, 1 << 20})
			for i := range 4 {
				if err := h.Push("Edit", h.Current().Value, makeSnapshot(t, float32(i+2))); err != nil {
					t.Fatal(err)
				}
			}
			original := h.States()
			id := original[tt.cursor].ID
			if _, err := h.Jump(id); err != nil {
				t.Fatal(err)
			}
			if err := h.SetLimits(tt.limits); err != nil {
				t.Fatal(err)
			}
			states := h.States()
			if h.CurrentID() != id || len(states) != len(tt.wantIDs) {
				t.Fatal("limit reconfiguration changed cursor or wrong states")
			}
			for i, want := range tt.wantIDs {
				if states[i].ID != original[want-1].ID {
					t.Fatalf("retained state %d = %s, want %s", i, states[i].ID, original[want-1].ID)
				}
			}
		})
	}
}

func TestHistoryExactUndoRedoSampleBits(t *testing.T) {
	values := []float32{}
	for _, bits := range []uint32{0x80000000, 0x7f801234, 0x7fc01234, 1, 0xff800000, 0x3f000000} {
		values = append(values, math.Float32frombits(bits))
	}
	initial := makeSnapshot(t, values...)
	h := newHistory(t, initial, Limits{100, 1 << 20})
	result, err := (ops.Delete{Range: ops.Range{Start: 1, End: 4, ChannelMask: 1}}).Apply(initial.document)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.Push("Delete", initial, snapshot{document: result}); err != nil {
		t.Fatal(err)
	}
	assertBits := func(document audiobuf.Document, want []float32) {
		t.Helper()
		channel, err := document.Channel(0)
		if err != nil {
			t.Fatal(err)
		}
		got := make([]float32, len(want))
		if channel.Read(got, 0) != len(want) || document.Frames() != int64(len(want)) {
			t.Fatal("restored wrong duration")
		}
		for i := range want {
			if math.Float32bits(got[i]) != math.Float32bits(want[i]) {
				t.Fatalf("restored bits frame %d = %08x, want %08x", i, math.Float32bits(got[i]), math.Float32bits(want[i]))
			}
		}
	}
	undo, err := h.Undo()
	if err != nil {
		t.Fatal(err)
	}
	assertBits(undo.document, values)
	redo, err := h.Redo()
	if err != nil {
		t.Fatal(err)
	}
	assertBits(redo.document, []float32{values[0], values[4], values[5]})
}
