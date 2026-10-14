package engine

import (
	"encoding/binary"
	"encoding/json"
	"math"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/history"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

// autosaveStore mirrors the worker store: records by ID, the last layout and
// the document state of the last complete delta.
type autosaveStore struct {
	records    map[uint32][]byte
	layout     [][]uint32
	document   protocol.AutosaveDocument
	generation int64
	nextID     uint32
	written    []uint32 // IDs of the most recent delta
	freed      []uint32
}

func newAutosaveStore() *autosaveStore {
	return &autosaveStore{records: make(map[uint32][]byte), nextID: 1}
}

func autosaveCall(t *testing.T, e *Engine, maxBytes int) (protocol.AutosaveDeltaResult, []byte) {
	t.Helper()
	response := editorCall(t, e, protocol.MethodAutosaveDelta, protocol.AutosaveDeltaParams{MaxBytes: maxBytes})
	if !response.OK {
		t.Fatalf("autosave.delta: %s", response.Error)
	}
	var result protocol.AutosaveDeltaResult
	if err := json.Unmarshal(response.Result, &result); err != nil {
		t.Fatal(err)
	}
	data := e.TakeData()
	if len(data) != result.DataBytes {
		t.Fatalf("delta data has %d bytes, metadata says %d", len(data), result.DataBytes)
	}
	return result, data
}

// apply parses one delta. Records and layout are checked for internal
// consistency so a malformed delta fails here, not in recovery.
func (s *autosaveStore) apply(t *testing.T, result protocol.AutosaveDeltaResult, data []byte) {
	t.Helper()
	if result.Generation != s.generation {
		clear(s.records)
		s.layout, s.generation, s.nextID = nil, result.Generation, 1
	}
	offset := 0
	next := func() uint32 {
		if len(data)-offset < 4 {
			t.Fatal("truncated delta")
		}
		value := binary.LittleEndian.Uint32(data[offset:])
		offset += 4
		return value
	}
	s.freed = make([]uint32, next())
	for i := range s.freed {
		s.freed[i] = next()
		if _, ok := s.records[s.freed[i]]; !ok {
			t.Fatalf("freed unknown block %d", s.freed[i])
		}
		delete(s.records, s.freed[i])
	}
	var layout [][]uint32
	if channels := next(); channels > 0 {
		layout = make([][]uint32, channels)
		for i := range layout {
			layout[i] = make([]uint32, next())
			for j := range layout[i] {
				layout[i][j] = next()
			}
		}
	}
	if (layout != nil || result.Document.Channels == 0) != result.Complete {
		t.Fatalf("layout presence does not match complete=%v", result.Complete)
	}
	s.written = make([]uint32, next())
	if len(s.written) != result.Blocks {
		t.Fatalf("delta has %d records, metadata says %d", len(s.written), result.Blocks)
	}
	for i := range s.written {
		start := offset
		id, frames := next(), int(next())
		if _, exists := s.records[id]; exists || id < s.nextID {
			t.Fatalf("block %d written twice or out of order", id)
		}
		offset += 4 * frames
		if offset > len(data) {
			t.Fatal("truncated record")
		}
		s.records[id] = slices.Clone(data[start:offset])
		s.written[i], s.nextID = id, id+1
	}
	if offset != len(data) {
		t.Fatalf("%d trailing delta bytes", len(data)-offset)
	}
	if result.Complete {
		s.layout, s.document = layout, result.Document
		for _, channel := range layout {
			for _, id := range channel {
				if _, ok := s.records[id]; !ok {
					t.Fatalf("layout references unwritten block %d", id)
				}
			}
		}
	}
}

// drain repeats deltas until one is complete and returns their count.
func (s *autosaveStore) drain(t *testing.T, e *Engine, maxBytes int) (int, []uint32) {
	t.Helper()
	var written []uint32
	for calls := 1; ; calls++ {
		result, data := autosaveCall(t, e, maxBytes)
		s.apply(t, result, data)
		written = append(written, s.written...)
		if result.Complete {
			return calls, written
		}
		if calls > 1000 {
			t.Fatal("autosave never completed")
		}
	}
}

// recover replays the store into target in batches of at most batch records.
func (s *autosaveStore) recover(t *testing.T, target *Engine, batch int) (protocol.DocumentInfoResult, error) {
	t.Helper()
	if _, err := target.beginRecovery(protocol.RecoveryBeginParams{NextBlockID: int64(s.nextID)}); err != nil {
		t.Fatal(err)
	}
	var live []uint32
	for _, channel := range s.layout {
		for _, id := range channel {
			if !slices.Contains(live, id) {
				live = append(live, id)
			}
		}
	}
	for start := 0; start < len(live); start += batch {
		var input []byte
		for _, id := range live[start:min(start+batch, len(live))] {
			input = append(input, s.records[id]...)
		}
		if _, err := target.stageRecoveryBlocks(input); err != nil {
			t.Fatal(err)
		}
	}
	return target.finishRecovery(s.document, s.layoutBytes())
}

func (s *autosaveStore) layoutBytes() []byte {
	data := binary.LittleEndian.AppendUint32(nil, uint32(len(s.layout)))
	for _, channel := range s.layout {
		data = binary.LittleEndian.AppendUint32(data, uint32(len(channel)))
		for _, id := range channel {
			data = binary.LittleEndian.AppendUint32(data, id)
		}
	}
	return data
}

func autosaveFixture(t *testing.T, frames int) *Engine {
	t.Helper()
	samples := make([]float32, 2*frames)
	for i := range samples {
		samples[i] = float32(math.Sin(float64(i)*0.001)) * float32(1+i%2)
	}
	e, _ := openEditorFixture(t, samples, 2)
	return e
}

func TestAutosaveDeltaWritesEachBlockOnce(t *testing.T) {
	e := autosaveFixture(t, 3*audiobuf.BlockFrames+17)
	store := newAutosaveStore()
	if calls, written := store.drain(t, e, 0); calls != 1 || len(written) != 8 {
		t.Fatalf("prefill took %d calls and wrote %d blocks, want 1 and 8", calls, len(written))
	}
	if store.document.Dirty || store.document.Name != "editor.wav" || store.document.SourceFormat != "wav" {
		t.Fatalf("unexpected document state %+v", store.document)
	}
	if _, written := store.drain(t, e, 0); len(written) != 0 || len(store.freed) != 0 {
		t.Fatalf("unchanged document rewrote %d blocks and freed %d", len(written), len(store.freed))
	}

	// A delete inside the second block replaces that block on both channels.
	if _, err := e.applyEdit(editParams(e, "delete", audiobuf.BlockFrames+10, audiobuf.BlockFrames+20, 3)); err != nil {
		t.Fatal(err)
	}
	_, written := store.drain(t, e, 0)
	if len(written) == 0 || len(written) > 4 || len(store.freed) != 0 {
		t.Fatalf("delete wrote %d blocks and freed %d; want only the changed boundary blocks, none freed (undo keeps them)", len(written), len(store.freed))
	}
	if !store.document.Dirty {
		t.Fatal("edited document is not dirty")
	}
	edited := editSamples(t, e)

	// Undo and redo only rearrange blocks that history retains.
	for _, method := range []string{protocol.MethodEditUndo, protocol.MethodEditRedo} {
		if _, err := e.navigateHistory(method, e.doc.editor.documentID, ""); err != nil {
			t.Fatal(err)
		}
		if _, written := store.drain(t, e, 0); len(written) != 0 || len(store.freed) != 0 {
			t.Fatalf("%s wrote %d blocks and freed %d", method, len(written), len(store.freed))
		}
	}

	target := New()
	if _, err := store.recover(t, target, 3); err != nil {
		t.Fatal(err)
	}
	assertEditBits(t, editSamples(t, target), edited)
	if !target.historyState.history.Dirty() || target.historyState.history.CanUndo() {
		t.Fatal("recovered document must be unsaved with fresh history")
	}
}

func TestAutosaveDeltaFreesBlocksHistoryNoLongerRetains(t *testing.T) {
	e := autosaveFixture(t, 2*audiobuf.BlockFrames)
	if err := e.historyState.history.SetLimits(history.Limits{MaxEntries: 1, MaxBytes: e.memory.capacity()}); err != nil {
		t.Fatal(err)
	}
	store := newAutosaveStore()
	store.drain(t, e, 0)
	original := slices.Clone(store.layout)
	for range 2 {
		if _, err := e.applyEdit(editParams(e, "mute", 0, 2*audiobuf.BlockFrames, 3)); err != nil {
			t.Fatal(err)
		}
	}
	store.drain(t, e, 0)
	var want []uint32
	for _, channel := range original {
		want = append(want, channel...)
	}
	slices.Sort(want)
	if !slices.Equal(store.freed, want) {
		t.Fatalf("freed %v, want the pruned original blocks %v", store.freed, want)
	}
}

func TestAutosaveDeltaChunksPrefill(t *testing.T) {
	e := autosaveFixture(t, 4*audiobuf.BlockFrames)
	store := newAutosaveStore()
	first, data := autosaveCall(t, e, minAutosaveBytes)
	store.apply(t, first, data)
	// Three 65,536-frame records fit 1 MiB; a fourth would not.
	if first.Complete || first.Blocks != 3 || first.Pending != 5 || len(data) > minAutosaveBytes+16 {
		t.Fatalf("first chunk: complete=%v blocks=%d pending=%d bytes=%d", first.Complete, first.Blocks, first.Pending, len(data))
	}
	calls, _ := store.drain(t, e, minAutosaveBytes)
	if calls != 2 || len(store.records) != 8 {
		t.Fatalf("remaining prefill took %d calls for %d blocks", calls, len(store.records))
	}
	for _, maxBytes := range []int{-1, minAutosaveBytes - 1, maxAutosaveBytes + 1} {
		if response := editorCall(t, e, protocol.MethodAutosaveDelta, protocol.AutosaveDeltaParams{MaxBytes: maxBytes}); response.OK {
			t.Fatalf("maxBytes %d accepted", maxBytes)
		}
	}
}

func TestAutosaveGenerationChangesWithTheDocument(t *testing.T) {
	e := autosaveFixture(t, 100)
	store := newAutosaveStore()
	store.drain(t, e, 0)
	generation := store.generation
	if response := editorCall(t, e, protocol.MethodDocumentNew, protocol.DocumentNewParams{SampleRate: 48000, Channels: 1, Frames: 10}); !response.OK {
		t.Fatal(response.Error)
	}
	_, written := store.drain(t, e, 0)
	if store.generation == generation || len(written) != 1 || store.written[0] != 1 {
		t.Fatalf("new document: generation %d → %d, wrote %v; want a new generation from ID 1", generation, store.generation, written)
	}

	empty := New()
	result, data := autosaveCall(t, empty, 0)
	if !result.Complete || result.Document.Channels != 0 || result.Document.Dirty || len(data) != 12 {
		t.Fatalf("empty editor delta: %+v (%d bytes)", result, len(data))
	}
}

func TestAutosaveRecoveryRestoresDocumentState(t *testing.T) {
	// FLAC-sized blocks with preserved container chunks, tags and anchors.
	const rate, blockFrames = 44100, 4096
	blocks := make([][]*audiobuf.Block, 2)
	for c := range blocks {
		for b := range 5 {
			samples := make([]float32, blockFrames)
			for i := range samples {
				samples[i] = float32(c+1) * float32(b*blockFrames+i) / 1e5
			}
			samples[0] = float32(math.NaN())
			block, err := audiobuf.NewBlock(samples)
			if err != nil {
				t.Fatal(err)
			}
			blocks[c] = append(blocks[c], block)
		}
	}
	channels := make([]audiobuf.Channel, 2)
	for c := range channels {
		var err error
		if channels[c], err = audiobuf.NewChannelFromBlocks(blocks[c]); err != nil {
			t.Fatal(err)
		}
	}
	document, err := audiobuf.NewDocument(channels, rate, audiobuf.Metadata{Name: "take.flac", WAVChunks: []audiobuf.FileChunk{{ID: [4]byte{'i', 'X', 'M', 'L'}, Data: []byte("<x/>")}}})
	if err != nil {
		t.Fatal(err)
	}
	e := New()
	if _, err := e.installDocument(document, 24, false, "flac"); err != nil {
		t.Fatal(err)
	}
	id := e.doc.editor.documentID
	if _, err := e.setMetadata(protocol.MetadataSetParams{DocumentID: id, StateID: e.historyState.history.CurrentID(), Tags: map[string]string{"title": "Take"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.addMarker(protocol.MarkerAddParams{DocumentID: e.doc.editor.documentID, Frame: 4100, Name: "cue"}); err != nil {
		t.Fatal(err)
	}
	selection := protocol.SelectionRange{Start: 10, End: 9000, ChannelMask: 2}
	e.doc.editor.selection = selection
	store := newAutosaveStore()
	store.drain(t, e, 0)

	target := New()
	info, err := store.recover(t, target, 4)
	if err != nil {
		t.Fatal(err)
	}
	if info.Name != "take.flac" || info.Format != "flac" || info.BitDepth != 24 || info.Float || info.SampleRate != rate || info.Frames != 5*blockFrames {
		t.Fatalf("recovered format %+v", info)
	}
	assertEditBits(t, editSamples(t, target), editSamples(t, e))
	// Name, tags, anchors, chunks, source format, selection and dirty state.
	if got, want := target.autosaveDocument(), e.autosaveDocument(); !reflect.DeepEqual(got, want) || got.Selection != selection || !got.Dirty {
		t.Fatalf("recovered state %+v, want %+v", got, want)
	}
	if target.autosave.stagedBytes != 0 || target.autosave.staged != nil {
		t.Fatal("staging survived recovery")
	}

	// The recovered session continues: nothing is rewritten, and new blocks
	// get IDs after every ID the store has seen.
	nextID := store.nextID
	result, data := autosaveCall(t, target, 0)
	store.generation = result.Generation // the store adopts the recovered session
	store.apply(t, result, data)
	if len(store.written) != 0 || len(store.freed) != 0 || !result.Complete {
		t.Fatalf("delta after recovery wrote %v, freed %v", store.written, store.freed)
	}
	if _, err := target.applyEdit(editParams(target, "mute", 0, 10, 1)); err != nil {
		t.Fatal(err)
	}
	result, data = autosaveCall(t, target, 0)
	store.apply(t, result, data)
	// Muting ten frames splits one block into a silent head and the remainder.
	if !slices.Equal(store.written, []uint32{nextID, nextID + 1}) {
		t.Fatalf("edit after recovery wrote %v, want [%d %d]", store.written, nextID, nextID+1)
	}
}

func TestAutosaveRecoveryRejectsInvalidInput(t *testing.T) {
	e := autosaveFixture(t, 1000)
	store := newAutosaveStore()
	store.drain(t, e, 0)
	record := store.records[store.layout[0][0]]

	target := New()
	if _, err := target.stageRecoveryBlocks(record); err == nil || !strings.Contains(err.Error(), "recovery.begin required") {
		t.Fatalf("blocks before begin: %v", err)
	}
	if _, err := target.beginRecovery(protocol.RecoveryBeginParams{}); err == nil {
		t.Fatal("nextBlockId 0 accepted")
	}
	if _, err := target.beginRecovery(protocol.RecoveryBeginParams{NextBlockID: int64(store.nextID)}); err != nil {
		t.Fatal(err)
	}
	before := target.retainedStorage()
	for name, input := range map[string][]byte{
		"truncated":  record[:len(record)-1],
		"header":     record[:5],
		"id zero":    append([]byte{0, 0, 0, 0}, record[4:]...),
		"id too big": append(binary.LittleEndian.AppendUint32(nil, store.nextID), record[4:]...),
		"duplicate":  append(slices.Clone(record), record...),
	} {
		if _, err := target.stageRecoveryBlocks(input); err == nil {
			t.Fatalf("%s record accepted", name)
		}
		if target.retainedStorage() != before || len(target.autosave.staged) != 0 {
			t.Fatalf("%s record changed staging", name)
		}
	}
	if _, err := target.stageRecoveryBlocks(record); err != nil {
		t.Fatal(err)
	}
	if target.retainedStorage() <= before {
		t.Fatal("staged blocks are not charged to the memory budget")
	}
	if _, err := target.stageRecoveryBlocks(record); err == nil {
		t.Fatal("block staged twice")
	}
	// Channel 1's block is missing; the layout must not install.
	if _, err := target.finishRecovery(store.document, store.layoutBytes()); err == nil || !strings.Contains(err.Error(), "missing block") {
		t.Fatalf("finish with missing block: %v", err)
	}
	if target.doc.document.Channels() != 0 {
		t.Fatal("failed recovery installed a document")
	}
	short := store.document
	short.Frames++
	if _, err := target.stageRecoveryBlocks(store.records[store.layout[1][0]]); err != nil {
		t.Fatal(err)
	}
	if _, err := target.finishRecovery(short, store.layoutBytes()); err == nil {
		t.Fatal("frame count mismatch accepted")
	}
	if _, err := target.finishRecovery(store.document, store.layoutBytes()[:6]); err == nil {
		t.Fatal("truncated layout accepted")
	}
	if response := editorCall(t, target, protocol.MethodRecoveryAbort, struct{}{}); !response.OK || target.retainedStorage() != before {
		t.Fatalf("abort: %s; staging still charged", response.Error)
	}
}
