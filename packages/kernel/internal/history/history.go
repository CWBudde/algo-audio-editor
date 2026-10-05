// Package history retains immutable application snapshots with shared audio
// storage. The caller owns snapshot construction and must not mutate T values.
package history

import (
	"fmt"
	"maps"
	"math"
	"slices"
	"strconv"
	"strings"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
)

// Limits bounds commands (not states) and unique sample plus cached-peak bytes.
// A history with MaxEntries commands may retain MaxEntries+1 states.
type Limits struct {
	MaxEntries int
	MaxBytes   int64
}

type State[T any] struct {
	ID    string
	Value T
}

type Entry[T any] struct {
	Label         string
	Before, After State[T]
}

// History is single-owner, not concurrent. Snapshot values are immutable;
// Clone shares its retained lists until a copy-on-write mutation occurs.
type History[T any] struct {
	states      []State[T]
	labels      []string
	baseLabel   string
	cursor      int
	sequence    uint64
	savedID     string
	limits      Limits
	bytes       int64
	document    func(T) audiobuf.Document
	inventories []audiobuf.BlockInventory
	owners      map[*audiobuf.Block]blockOwnership
	sampleBytes int64
	references  int
}

// Each inventory owns a block once, regardless of repeated channel references.
// The ledger is copied before staged mutations; Clone can share it safely.
type blockOwnership struct {
	states int
	bytes  int64
}

func validateLimits(limits Limits) error {
	if limits.MaxEntries < 1 || limits.MaxBytes < 1 {
		return fmt.Errorf("positive command and byte limits are required")
	}
	return nil
}

func New[T any](initial T, initialLabel string, limits Limits, document func(T) audiobuf.Document) (*History[T], error) {
	if err := validateLimits(limits); err != nil {
		return nil, fmt.Errorf("history.new: limits: %w", err)
	}
	if document == nil {
		return nil, fmt.Errorf("history.new: document accessor is required")
	}
	if strings.TrimSpace(initialLabel) == "" {
		return nil, fmt.Errorf("history.new: initial label is required")
	}
	h := &History[T]{
		states:    []State[T]{{ID: "state-1", Value: initial}},
		baseLabel: initialLabel, sequence: 1, savedID: "state-1",
		limits: limits, document: document,
	}
	h.inventories = []audiobuf.BlockInventory{document(initial).BlockInventory()}
	h.owners = make(map[*audiobuf.Block]blockOwnership)
	h.addInventory(h.inventories[0])
	if h.bytes > limits.MaxBytes {
		return nil, fmt.Errorf("history.new: initial retained audio exceeds the %d-byte budget", limits.MaxBytes)
	}
	return h, nil
}

func (h *History[T]) Current() State[T] { return h.states[h.cursor] }

func (h *History[T]) CurrentID() string { return h.Current().ID }

func (h *History[T]) SavedID() string { return h.savedID }

func (h *History[T]) BaseLabel() string { return h.baseLabel }

func (h *History[T]) Limits() Limits { return h.limits }

func (h *History[T]) RetainedBytes() int64 { return h.bytes }

func (h *History[T]) CanUndo() bool { return h.cursor > 0 }

func (h *History[T]) CanRedo() bool { return h.cursor < len(h.labels) }

func (h *History[T]) Dirty() bool { return h.CurrentID() != h.savedID }

// MarkUnsaved initializes a newly created document without a saved file state.
func (h *History[T]) MarkUnsaved() { h.savedID = "" }

func (h *History[T]) States() []State[T] { return slices.Clone(h.states) }

func (h *History[T]) Entries() []Entry[T] {
	entries := make([]Entry[T], len(h.labels))
	for i, label := range h.labels {
		entries[i] = Entry[T]{Label: label, Before: h.states[i], After: h.states[i+1]}
	}
	return entries
}

// Documents supplies all retained snapshots for deduplicated accounting.
// Clipboard windows are intentionally outside this manager.
func (h *History[T]) Documents() []audiobuf.Document {
	documents := make([]audiobuf.Document, len(h.states))
	for i, state := range h.states {
		documents[i] = h.document(state.Value)
	}
	return documents
}

func (h *History[T]) addInventory(inventory audiobuf.BlockInventory) {
	h.references += inventory.MemoryStats().BlockReferences
	for block, bytes := range inventory.Blocks {
		ownership := h.owners[block]
		if ownership.states == 0 {
			h.bytes += bytes
			h.sampleBytes += int64(block.Frames()) * 4
			ownership.bytes = bytes
		}
		ownership.states++
		h.owners[block] = ownership
	}
}

func (h *History[T]) removeInventory(inventory audiobuf.BlockInventory) {
	h.references -= inventory.MemoryStats().BlockReferences
	for block := range inventory.Blocks {
		ownership := h.owners[block]
		if ownership.states == 1 {
			h.bytes -= ownership.bytes
			h.sampleBytes -= int64(block.Frames()) * 4
			delete(h.owners, block)
		} else {
			ownership.states--
			h.owners[block] = ownership
		}
	}
}

// MemoryStats reports cached retained sample/peak bytes and structural overhead
// counts, optionally deduplicating extra documents and clipboard views against
// history. Only supplemental storage is visited; retained states are not read.
func (h *History[T]) MemoryStats(documents []audiobuf.Document, windows ...audiobuf.Window) audiobuf.MemoryStats {
	stats := audiobuf.MemoryStats{
		SampleBytes:     h.sampleBytes,
		PeakBytes:       h.bytes - h.sampleBytes,
		UniqueBlocks:    len(h.owners),
		BlockReferences: h.references,
	}
	if len(documents) == 0 && len(windows) == 0 {
		return stats
	}
	extra := audiobuf.NewBlockInventory(documents, windows...)
	stats.BlockReferences += extra.MemoryStats().BlockReferences
	for block, bytes := range extra.Blocks {
		if _, retained := h.owners[block]; retained {
			continue
		}
		sampleBytes := int64(block.Frames()) * 4
		stats.SampleBytes += sampleBytes
		stats.PeakBytes += bytes - sampleBytes
		stats.UniqueBlocks++
	}
	return stats
}

func (h *History[T]) Clone() *History[T] {
	clone := *h
	return &clone
}

// StagePush does not mutate h, even when a new branch replaces redo states.
// Before refreshes the current state's editor metadata while preserving its ID.
func (h *History[T]) StagePush(label string, before, after T) (*History[T], error) {
	if strings.TrimSpace(label) == "" {
		return nil, fmt.Errorf("history.push: label is required")
	}
	if h.sequence == math.MaxUint64 {
		return nil, fmt.Errorf("history.push: state identity sequence exhausted")
	}
	staged := h.Clone()
	staged.owners = maps.Clone(h.owners)
	for _, inventory := range h.inventories[h.cursor+1:] {
		staged.removeInventory(inventory)
	}
	staged.removeInventory(h.inventories[h.cursor])
	staged.inventories = make([]audiobuf.BlockInventory, h.cursor+2)
	copy(staged.inventories, h.inventories[:h.cursor])
	staged.inventories[h.cursor] = h.document(before).BlockInventory()
	staged.inventories[h.cursor+1] = h.document(after).BlockInventory()
	staged.addInventory(staged.inventories[h.cursor])
	staged.addInventory(staged.inventories[h.cursor+1])
	staged.states = make([]State[T], h.cursor+2)
	copy(staged.states, h.states[:h.cursor+1])
	staged.states[h.cursor].Value = before
	staged.sequence++
	staged.states[h.cursor+1] = State[T]{ID: "state-" + strconv.FormatUint(staged.sequence, 10), Value: after}
	staged.labels = make([]string, h.cursor+1)
	copy(staged.labels, h.labels[:h.cursor])
	staged.labels[h.cursor] = label
	staged.cursor++
	if err := staged.prune(); err != nil {
		return nil, fmt.Errorf("history.push: retain undoable edit: %w", err)
	}
	return staged, nil
}

func (h *History[T]) Push(label string, before, after T) error {
	staged, err := h.StagePush(label, before, after)
	if err != nil {
		return err
	}
	*h = *staged
	return nil
}

// ReplaceCurrent refreshes immutable editor metadata without creating an edit,
// changing an ID or dirty state. The caller must preserve the logical audio;
// the byte check prevents accidental unbounded new audio retention.
func (h *History[T]) ReplaceCurrent(value T) error {
	staged := h.Clone()
	staged.states = slices.Clone(h.states)
	staged.states[h.cursor].Value = value
	staged.owners = maps.Clone(h.owners)
	staged.inventories = slices.Clone(h.inventories)
	staged.removeInventory(h.inventories[h.cursor])
	staged.inventories[h.cursor] = h.document(value).BlockInventory()
	staged.addInventory(staged.inventories[h.cursor])
	if staged.bytes > staged.limits.MaxBytes {
		return fmt.Errorf("history.replaceCurrent: retained audio exceeds the %d-byte budget", staged.limits.MaxBytes)
	}
	*h = *staged
	return nil
}

// prune drops oldest undo states first, then farthest redo states. The current
// and immediate undo pair (or nearest redo pair at base) are never discarded.
// A final exact-size copy releases evicted values, including hidden slice slots.
func (h *History[T]) prune() error {
	pruned := false
	for len(h.labels) > h.limits.MaxEntries || h.bytes > h.limits.MaxBytes {
		switch {
		case h.cursor > 1:
			h.removeInventory(h.inventories[0])
			h.baseLabel = h.labels[0]
			h.states, h.labels = h.states[1:], h.labels[1:]
			h.inventories = h.inventories[1:]
			h.cursor--
		case len(h.labels) > max(h.cursor, 1):
			h.removeInventory(h.inventories[len(h.inventories)-1])
			h.states = h.states[:len(h.states)-1]
			h.inventories = h.inventories[:len(h.inventories)-1]
			h.labels = h.labels[:len(h.labels)-1]
		default:
			return fmt.Errorf("current undo/redo pair exceeds the %d-byte budget", h.limits.MaxBytes)
		}
		pruned = true
	}
	if pruned {
		h.states, h.labels = slices.Clone(h.states), slices.Clone(h.labels)
		h.inventories = slices.Clone(h.inventories)
	}
	return nil
}

// SetLimits atomically reconfigures capacity, preserving an undoable current
// edit. It is a core configuration facility, not an application settings API.
func (h *History[T]) SetLimits(limits Limits) error {
	if err := validateLimits(limits); err != nil {
		return fmt.Errorf("history.setLimits: %w", err)
	}
	staged := h.Clone()
	staged.owners = maps.Clone(h.owners)
	staged.limits = limits
	if err := staged.prune(); err != nil {
		return fmt.Errorf("history.setLimits: %w", err)
	}
	*h = *staged
	return nil
}

func (h *History[T]) Undo() (T, error) {
	if !h.CanUndo() {
		var zero T
		return zero, fmt.Errorf("history.undo: no undo state")
	}
	h.cursor--
	return h.Current().Value, nil
}

func (h *History[T]) Redo() (T, error) {
	if !h.CanRedo() {
		var zero T
		return zero, fmt.Errorf("history.redo: no redo state")
	}
	h.cursor++
	return h.Current().Value, nil
}

func (h *History[T]) Jump(stateID string) (T, error) {
	for i, state := range h.states {
		if state.ID == stateID {
			h.cursor = i
			return state.Value, nil
		}
	}
	var zero T
	return zero, fmt.Errorf("history.jump: unknown or evicted state identity %q", stateID)
}

// MarkSaved stores only an identity, never an extra audio snapshot. A branched
// or evicted save point remains dirty until the current state is saved again.
func (h *History[T]) MarkSaved(stateID string) error {
	if stateID != h.CurrentID() {
		return fmt.Errorf("history.markSaved: identity is not the current retained state")
	}
	h.savedID = stateID
	return nil
}
