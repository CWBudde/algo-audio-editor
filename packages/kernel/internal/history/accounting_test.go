package history

import (
	"fmt"
	"maps"
	"math/rand/v2"
	"reflect"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
)

func assertAccounting(t testing.TB, h *History[snapshot]) {
	t.Helper()
	oracle := audiobuf.CountMemory(h.Documents()...)
	if cached := h.MemoryStats(nil); cached != oracle {
		t.Fatalf("cached memory=%+v; oracle=%+v", cached, oracle)
	}
	if h.bytes != oracle.SampleBytes+oracle.PeakBytes || len(h.owners) != oracle.UniqueBlocks || len(h.inventories) != len(h.states) {
		t.Fatalf("ledger bytes=%d blocks=%d inventories=%d; oracle=%+v states=%d", h.bytes, len(h.owners), len(h.inventories), oracle, len(h.states))
	}
	expectedOwners := make(map[*audiobuf.Block]blockOwnership)
	for _, state := range h.states {
		for block, bytes := range state.Value.document.BlockInventory().Blocks {
			owner := expectedOwners[block]
			owner.states++
			owner.bytes = bytes
			expectedOwners[block] = owner
		}
	}
	if !reflect.DeepEqual(h.owners, expectedOwners) {
		t.Fatal("per-state ownership diverged from retained snapshots")
	}
	for _, inventory := range h.inventories[len(h.inventories):cap(h.inventories)] {
		for range inventory.Blocks {
			t.Fatal("evicted inventory retained in hidden backing-array slot")
		}
	}
}

func TestHistoryIncrementalAccountingRandomized(t *testing.T) {
	// Different documents deliberately share channels and repeat backing blocks.
	// Cached peaks are a substantial part of these short-block charges.
	pool := make([]snapshot, 12)
	for i := range 4 {
		pool[i] = makeSnapshot(t, make([]float32, 257+i*33)...)
	}
	for i := 4; i < len(pool); i++ {
		a, err := pool[i%4].document.Channel(0)
		if err != nil {
			t.Fatal(err)
		}
		b, err := pool[(i+1)%4].document.Channel(0)
		if err != nil {
			t.Fatal(err)
		}
		channel := a.Concat(b).Concat(a)
		document, err := audiobuf.NewDocument([]audiobuf.Channel{channel, channel}, 48000, audiobuf.Metadata{Name: fmt.Sprintf("pool-%d", i)})
		if err != nil {
			t.Fatal(err)
		}
		pool[i] = snapshot{document: document}
	}
	for _, seed := range []uint64{1, 42, 9182} {
		t.Run(fmt.Sprintf("seed-%d", seed), func(t *testing.T) {
			rng := rand.New(rand.NewPCG(seed, seed+1))
			h := newHistory(t, pool[0], Limits{MaxEntries: 5, MaxBytes: 1 << 20})
			for step := range 600 {
				before := h.Clone()
				beforeStates, beforeOwners := h.States(), maps.Clone(h.owners)
				var err error
				switch rng.IntN(7) {
				case 0, 1:
					value := pool[rng.IntN(len(pool))]
					value.selection = int64(step)
					refresh := h.Current().Value
					if rng.IntN(4) == 0 {
						refresh = pool[rng.IntN(len(pool))]
					}
					err = h.Push("Edit", refresh, value)
				case 2:
					err = h.ReplaceCurrent(pool[rng.IntN(len(pool))])
				case 3:
					_, err = h.Undo()
				case 4:
					_, err = h.Redo()
				case 5:
					_, err = h.Jump(h.states[rng.IntN(len(h.states))].ID)
				case 6:
					// Tiny limits induce both partial-prune failures and success.
					err = h.SetLimits(Limits{MaxEntries: 1 + rng.IntN(6), MaxBytes: int64(800 + rng.IntN(5500))})
				}
				if err != nil && (!reflect.DeepEqual(h.States(), beforeStates) || !reflect.DeepEqual(h.owners, beforeOwners) || h.bytes != before.bytes || h.cursor != before.cursor || h.sequence != before.sequence || h.limits != before.limits) {
					t.Fatalf("step %d: failed action mutated history: %v", step, err)
				}
				assertAccounting(t, h)
				assertAccounting(t, before)
			}
		})
	}
}

func TestHistoryAccountsOnlyChangedSnapshots(t *testing.T) {
	initial := makeSnapshot(t, 1, 2, 3)
	calls := 0
	h, err := New(initial, "Initial", Limits{MaxEntries: 8, MaxBytes: 1 << 20}, func(value snapshot) audiobuf.Document {
		calls++
		return value.document
	})
	if err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("initial inventories built %d times", calls)
	}
	for range 20 {
		calls = 0
		if err := h.Push("Metadata", h.Current().Value, initial); err != nil {
			t.Fatal(err)
		}
		if calls != 2 {
			t.Fatalf("push inspected %d snapshots; want only before and after", calls)
		}
	}
	calls = 0
	if err := h.SetLimits(Limits{MaxEntries: 1, MaxBytes: 1 << 20}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Undo(); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Redo(); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Jump(h.CurrentID()); err != nil {
		t.Fatal(err)
	}
	_ = h.MemoryStats(nil)
	if calls != 0 {
		t.Fatalf("pruning/navigation rebuilt %d unchanged inventories", calls)
	}
	if err := h.ReplaceCurrent(initial); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("replacement inspected %d snapshots", calls)
	}
	assertAccounting(t, h)
}

func TestHistoryCachedMemoryWithAdditionalStorage(t *testing.T) {
	a := makeSnapshot(t, make([]float32, 513)...)
	b := makeSnapshot(t, make([]float32, 257)...)
	aChannel, err := a.document.Channel(0)
	if err != nil {
		t.Fatal(err)
	}
	bChannel, err := b.document.Channel(0)
	if err != nil {
		t.Fatal(err)
	}
	shared := aChannel.Concat(aChannel)
	initial, err := audiobuf.NewDocument([]audiobuf.Channel{shared, shared}, 48000, audiobuf.Metadata{})
	if err != nil {
		t.Fatal(err)
	}
	h := newHistory(t, snapshot{document: initial}, Limits{MaxEntries: 5, MaxBytes: 1 << 20})
	if err := h.Push("Shared", h.Current().Value, a); err != nil {
		t.Fatal(err)
	}
	candidateChannel := shared.Concat(bChannel)
	candidate, err := audiobuf.NewDocument([]audiobuf.Channel{candidateChannel, candidateChannel}, 48000, audiobuf.Metadata{})
	if err != nil {
		t.Fatal(err)
	}
	sharedWindow, err := shared.Window(1, shared.Frames()-1)
	if err != nil {
		t.Fatal(err)
	}
	extraWindow, err := bChannel.Window(1, bChannel.Frames()-1)
	if err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		name      string
		documents []audiobuf.Document
		windows   []audiobuf.Window
	}{
		{"history only", nil, nil},
		{"fractional shared backing", nil, []audiobuf.Window{sharedWindow}},
		{"fractional external backing", nil, []audiobuf.Window{extraWindow}},
		{"candidate shares history", []audiobuf.Document{candidate}, nil},
		{"repeated candidate and windows", []audiobuf.Document{candidate, candidate}, []audiobuf.Window{sharedWindow, extraWindow, extraWindow}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			beforeOwners := maps.Clone(h.owners)
			got := h.MemoryStats(tt.documents, tt.windows...)
			documents := append(h.Documents(), tt.documents...)
			want := audiobuf.CountMemoryWithWindows(documents, tt.windows...)
			if got != want {
				t.Fatalf("memory=%+v; oracle=%+v", got, want)
			}
			if !reflect.DeepEqual(h.owners, beforeOwners) {
				t.Fatal("additional-storage query mutated history ownership")
			}
			assertAccounting(t, h)
		})
	}
}

func BenchmarkHistoryCachedMemoryHourAtCapacity(b *testing.B) {
	h, _, _ := buildHourHistory(b)
	channel, err := h.Current().Value.document.Channel(0)
	if err != nil {
		b.Fatal(err)
	}
	window, err := channel.Window(127, 2*audiobuf.BlockFrames+127)
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	for b.Loop() {
		stats := h.MemoryStats(nil, window)
		if stats.SampleBytes+stats.PeakBytes != h.bytes {
			b.Fatal("shared clipboard charged extra storage")
		}
	}
}

func BenchmarkHistoryPushHourMetadataAtCapacity(b *testing.B) {
	baseline, _, _ := buildHourHistory(b)
	b.ReportAllocs()
	for b.Loop() {
		h := baseline.Clone()
		before := h.Current().Value
		after := before
		after.selection++
		if err := h.Push("Metadata", before, after); err != nil {
			b.Fatal(err)
		}
		if len(h.states) != hourEdits+1 || h.bytes != baseline.bytes {
			b.Fatal("metadata push changed capacity or block storage")
		}
	}
}
