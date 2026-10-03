package engine

import (
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/history"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func historyNavigate(t *testing.T, e *Engine, method, stateID string) protocol.EditResult {
	t.Helper()
	result, err := e.navigateHistory(method, e.editor.documentID, stateID)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestHistoryAllAudioEditsRestoreExactSnapshots(t *testing.T) {
	for _, operation := range []string{"delete", "cut", "paste-insert", "paste-replace", "paste-mix", "crop", "insert-silence", "duplicate", "swap-channels", "mute"} {
		t.Run(operation, func(t *testing.T) {
			original := []float32{math.Float32frombits(0x80000000), 10, math.Float32frombits(0x7fc12345), 20, math.Float32frombits(1), 30, 2, 40}
			e, initialDocID := openEditorFixture(t, original, 2)
			initialStateID := e.historyResult().CurrentStateID
			if _, err := e.applyEdit(editParams(e, "copy", 0, 1, 3)); err != nil {
				t.Fatal(err)
			}
			setTimelineFixture(t, e, []protocol.TimelineMarker{{ID: 1, Frame: 4, Name: "end"}}, []protocol.TimelineRegion{{ID: 2, Start: 2, End: 4, Name: "tail"}})
			beforeTimeline := e.timelineResult()
			p := editParams(e, operation, 1, 3, 3)
			frames := int64(2)
			p.Frames = &frames
			after, err := e.applyEdit(p)
			if err != nil {
				t.Fatal(err)
			}
			if !after.History.Dirty || !after.History.CanUndo || after.History.CanRedo || len(after.History.Entries) != 2 || after.History.SavedStateID != initialStateID {
				t.Fatalf("afterhistory %+v", after.History)
			}
			afterSamples := editSamples(t, e)
			clip := e.clipboardInfo()
			playRange(t, e, 0, e.document.Frames(), true)
			undone := historyNavigate(t, e, protocol.MethodEditUndo, "")
			if !undone.Changed || undone.History.Dirty || undone.History.CanUndo || !undone.History.CanRedo || undone.Document.DocumentID == initialDocID || undone.Document.DocumentID == after.Document.DocumentID {
				t.Fatalf("undo %+v", undone)
			}
			if e.transport != nil || e.source != sourceStopped || e.clipboardInfo() != clip {
				t.Fatal("undo transport/clipboard invariant")
			}
			assertEditBits(t, editSamples(t, e), original)
			beforeTimeline.DocumentID = undone.Document.DocumentID
			if !reflect.DeepEqual(undone.Timeline, beforeTimeline) || undone.Selection.SelectionRange != p.SelectionRange || e.document.Metadata().Timeline.NextID != 3 {
				t.Fatal("undo selection/anchor snapshot mismatch")
			}
			redone := historyNavigate(t, e, protocol.MethodEditRedo, "")
			assertEditBits(t, editSamples(t, e), afterSamples)
			after.Timeline.DocumentID = redone.Document.DocumentID
			if !reflect.DeepEqual(redone.Timeline, after.Timeline) || redone.Selection.SelectionRange != after.Selection.SelectionRange || !redone.History.Dirty || e.clipboardInfo() != clip {
				t.Fatal("redo snapshot/clipboard mismatch")
			}
		})
	}
}

func TestHistoryLiveControlsBranchingAndNoops(t *testing.T) {
	e, _ := openEditorFixture(t, []float32{1, 10, 2, 20, 3, 30, 4, 40}, 2)
	initial := e.historyResult()
	if _, err := e.applyEdit(editParams(e, "copy", 0, 1, 3)); err != nil {
		t.Fatal(err)
	}
	for _, operation := range []string{"delete", "mute", "duplicate"} {
		if _, err := e.applyEdit(editParams(e, operation, 1, 1, 3)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := e.setSelection(protocol.SelectionSetParams{DocumentID: e.editor.documentID, SelectionRange: protocol.SelectionRange{Start: 1, End: 2, ChannelMask: 1}}); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(initial, e.historyResult()) {
		t.Fatal("copy/no-op/selection added history or dirty step")
	}
	if _, err := e.applyEdit(editParams(e, "mute", 0, 1, 1)); err != nil {
		t.Fatal(err)
	}
	live := protocol.SelectionRange{Start: 2, End: 3, ChannelMask: 2}
	if _, err := e.setSelection(protocol.SelectionSetParams{DocumentID: e.editor.documentID, SelectionRange: live}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.addMarker(protocol.MarkerAddParams{DocumentID: e.editor.documentID, Frame: 2, Name: "late"}); err != nil {
		t.Fatal(err)
	}
	state := e.historyResult().CurrentStateID
	historyNavigate(t, e, protocol.MethodEditUndo, "")
	if len(e.timelineResult().Markers) != 0 {
		t.Fatal("live late marker leaked into preceding state")
	}
	r := historyNavigate(t, e, protocol.MethodEditRedo, "")
	if r.Selection.SelectionRange != live || len(r.Timeline.Markers) != 1 || r.History.CurrentStateID != state {
		t.Fatal("redo lost controls changed before undo")
	}
	historyNavigate(t, e, protocol.MethodEditUndo, "")
	if _, err := e.applyEdit(editParams(e, "copy", 1, 2, 2)); err != nil {
		t.Fatal(err)
	}
	if !e.historyResult().CanRedo {
		t.Fatal("copy discarded redo")
	}
	if _, err := e.applyEdit(editParams(e, "mute", 1, 2, 2)); err != nil {
		t.Fatal(err)
	}
	if e.historyResult().CanRedo || e.historyResult().CurrentStateID == state {
		t.Fatal("branch failed to truncate redo/use freshstateID")
	}
	if _, err := e.navigateHistory(protocol.MethodHistoryJump, e.editor.documentID, state); err == nil {
		t.Fatal("discarded redo state was reachable")
	}
}

func TestHistorySavepointsExportAndOpenLifecycle(t *testing.T) {
	e, id := openEditorFixture(t, []float32{1, 10, 2, 20}, 2)
	initial := e.historyResult()
	if initial.Dirty || initial.CurrentStateID == "" || initial.CurrentStateID != initial.SavedStateID {
		t.Fatalf("initial %+v", initial)
	}
	if _, err := e.applyEdit(editParams(e, "mute", 0, 1, 3)); err != nil {
		t.Fatal(err)
	}
	dirty := e.historyResult()
	if _, err := e.exportDocument(protocol.DocumentExportParams{Format: "wav", BitDepth: 32, Float: true}); err != nil {
		t.Fatal(err)
	}
	if !e.historyResult().Dirty {
		t.Fatal("export alone marked saved")
	}
	for _, p := range []protocol.MarkSavedParams{{DocumentID: id, StateID: initial.CurrentStateID}, {DocumentID: e.editor.documentID, StateID: initial.CurrentStateID}, {DocumentID: e.editor.documentID, StateID: "unknown"}} {
		if _, err := e.markSaved(p); err == nil {
			t.Fatal("stale save ack accepted")
		}
	}
	saved, err := e.markSaved(protocol.MarkSavedParams{DocumentID: e.editor.documentID, StateID: dirty.CurrentStateID})
	if err != nil || saved.Dirty {
		t.Fatalf("save %+v %v", saved, err)
	}
	undone := historyNavigate(t, e, protocol.MethodEditUndo, "")
	if !undone.History.Dirty {
		t.Fatal("undo away from saved state reportedclean")
	}
	redone := historyNavigate(t, e, protocol.MethodEditRedo, "")
	if redone.History.Dirty {
		t.Fatal("redo to saved state reporteddirty")
	}
	if _, err = e.applyEdit(editParams(e, "copy", 0, 1, 3)); err != nil {
		t.Fatal(err)
	}
	before := e.editResult(false)
	if _, err = e.openDocument(protocol.DocumentOpenParams{}, []byte("bad")); err == nil {
		t.Fatal("bad open accepted")
	}
	if !reflect.DeepEqual(before, e.editResult(false)) {
		t.Fatal("failed open changedhistory/editor/clipboard")
	}
	if _, err = e.openDocument(protocol.DocumentOpenParams{}, rawWAV(3, 32, 2, 48000, floatPayload(32, []float64{9, 10}), false)); err != nil {
		t.Fatal(err)
	}
	after := e.historyResult()
	if after.Dirty || after.CanUndo || after.CanRedo || len(after.Entries) != 1 || e.clipboardInfo() != before.Clipboard {
		t.Fatal("successful open failedresetclean/preserveclip")
	}
}

func TestHistoryNavigationStaleIDsNoopAndRPC(t *testing.T) {
	e, _ := openEditorFixture(t, []float32{1, 10, 2, 20, 3, 30}, 2)
	if _, err := e.applyEdit(editParams(e, "mute", 0, 1, 3)); err != nil {
		t.Fatal(err)
	}
	playRange(t, e, 0, 3, true)
	before := e.editResult(false)
	transport := e.transport
	noop := historyNavigate(t, e, protocol.MethodHistoryJump, before.History.CurrentStateID)
	if noop.Changed || !reflect.DeepEqual(before, noop) || e.transport != transport || !transport.playing {
		t.Fatal("current jump changedstate/playback")
	}
	for _, args := range [][3]string{{protocol.MethodHistoryJump, e.editor.documentID, "missing"}, {protocol.MethodEditUndo, "stale", ""}, {protocol.MethodEditRedo, e.editor.documentID, ""}} {
		if _, err := e.navigateHistory(args[0], args[1], args[2]); err == nil {
			t.Fatal("invalid navigation accepted")
		}
		if !reflect.DeepEqual(before, e.editResult(false)) || e.transport != transport || !transport.playing {
			t.Fatal("invalidnavigation changedstate")
		}
	}
	e.documentSequence = math.MaxUint64
	if _, err := e.navigateHistory(protocol.MethodEditUndo, e.editor.documentID, ""); err == nil {
		t.Fatal("identityoverflow accepted")
	}
	if !reflect.DeepEqual(before, e.editResult(false)) {
		t.Fatal("failed overflow advancedhistory")
	}
	e.documentSequence = 2
	if !editorCall(t, e, protocol.MethodHistoryList, protocol.HistoryListParams{DocumentID: e.editor.documentID}).OK {
		t.Fatal("listdispatch")
	}
	if !editorCall(t, e, protocol.MethodEditUndo, protocol.HistoryListParams{DocumentID: e.editor.documentID}).OK {
		t.Fatal("undodispatch")
	}
	if !editorCall(t, e, protocol.MethodHistoryJump, protocol.HistoryJumpParams{DocumentID: e.editor.documentID, StateID: before.History.CurrentStateID}).OK {
		t.Fatal("jumpdispatch")
	}
	if !editorCall(t, e, protocol.MethodMarkSaved, protocol.MarkSavedParams{DocumentID: e.editor.documentID, StateID: before.History.CurrentStateID}).OK {
		t.Fatal("saveddispatch")
	}
}

func TestHistoryCountRetentionMemoryAndEvictedSavepoint(t *testing.T) {
	e, _ := openEditorFixture(t, []float32{1, 10, 2, 20}, 2)
	saved := e.historyResult().SavedStateID
	for range 110 {
		if _, err := e.applyEdit(editParams(e, "swap-channels", 0, 0, 3)); err != nil {
			t.Fatal(err)
		}
	}
	list := e.historyResult()
	if list.MaxEntries != 100 || len(list.Entries) != 101 || list.SavedStateID != saved || !list.Dirty {
		t.Fatalf("retention %+v", list)
	}
	for _, entry := range list.Entries {
		if entry.StateID == saved {
			t.Fatal("old base not evicted")
		}
	}
	stats := audiobuf.CountMemory(e.history.Documents()...)
	if list.RetainedBytes != stats.SampleBytes+stats.PeakBytes || e.documentMemory().SampleBytes != stats.SampleBytes || e.documentMemory().PeakBytes != stats.PeakBytes {
		t.Fatal("history memory doublecounted")
	}
	for range 100 {
		historyNavigate(t, e, protocol.MethodEditUndo, "")
	}
	if e.historyResult().CanUndo || !e.historyResult().Dirty {
		t.Fatal("retentionundo/savepoint boundary")
	}
}

func TestHistoryBudgetRejectsEditAtomically(t *testing.T) {
	e, _ := openEditorFixture(t, []float32{1, 10, 2, 20, 3, 30, 4, 40}, 2)
	if _, err := e.applyEdit(editParams(e, "copy", 0, 1, 1)); err != nil {
		t.Fatal(err)
	}
	snapshot := historySnapshot{document: e.document, editor: cloneEditor(e.editor)}
	stats := audiobuf.CountMemory(e.document)
	var err error
	e.history, err = history.New(snapshot, "Opened", history.Limits{MaxEntries: 100, MaxBytes: stats.SampleBytes + stats.PeakBytes}, func(s historySnapshot) audiobuf.Document { return s.document })
	if err != nil {
		t.Fatal(err)
	}
	setTimelineFixture(t, e, []protocol.TimelineMarker{{ID: 1, Frame: 4, Name: "end"}}, nil)
	playRange(t, e, 0, 4, true)
	before := e.editResult(false)
	transport := e.transport
	memory := e.documentMemory()
	response := editorCall(t, e, protocol.MethodEditApply, editParams(e, "cut", 1, 3, 3))
	if response.OK || !strings.Contains(response.Error, "budget") {
		t.Fatalf("expected historybudgeterror %+v", response)
	}
	if !reflect.DeepEqual(before, e.editResult(false)) || e.documentMemory() != memory || e.transport != transport || !transport.playing {
		t.Fatal("budgeterror mutated document/editor/clip/history/transport")
	}
	assertEditBits(t, editSamples(t, e), []float32{1, 10, 2, 20, 3, 30, 4, 40})
}

func TestHistoryAnchorSequenceRestoredAfterDroppedRegions(t *testing.T) {
	e, _ := openEditorFixture(t, []float32{1, 2, 3, 4}, 1)
	if _, err := e.addMarker(protocol.MarkerAddParams{DocumentID: e.editor.documentID, Frame: 0}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.addRegion(protocol.RegionAddParams{DocumentID: e.editor.documentID, Start: 2, End: 4}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.applyEdit(editParams(e, "delete", 2, 4, 1)); err != nil {
		t.Fatal(err)
	}
	if _, err := e.addMarker(protocol.MarkerAddParams{DocumentID: e.editor.documentID, Frame: 2}); err != nil {
		t.Fatal(err)
	}
	if e.timelineResult().Markers[1].ID != 3 {
		t.Fatal("droppedregion reusedanchorID")
	}
	historyNavigate(t, e, protocol.MethodEditUndo, "")
	if e.document.Metadata().Timeline.NextID != 3 || len(e.timelineResult().Regions) != 0 {
		t.Fatal("metadata-only undo failedrestore")
	}
	historyNavigate(t, e, protocol.MethodEditUndo, "")
	if e.document.Metadata().Timeline.NextID != 3 || len(e.timelineResult().Regions) != 1 {
		t.Fatal("anchor sequence/snapshot failedrestore")
	}
	historyNavigate(t, e, protocol.MethodEditRedo, "")
	historyNavigate(t, e, protocol.MethodEditRedo, "")
	if e.document.Metadata().Timeline.NextID != 4 || len(e.timelineResult().Regions) != 0 || len(e.timelineResult().Markers) != 2 {
		t.Fatal("liveanchor edits lost acrossnavigation")
	}
}

// This has real one-hour frame/block-list geometry without a duration-sized
// fixture allocation; unchanged immutable blocks deliberately repeat.
func oneHourHistoryEngine(t testing.TB) *Engine {
	t.Helper()
	const frames int64 = 48000 * 3600
	channels := make([]audiobuf.Channel, 2)
	for c := range channels {
		samples := make([]float32, audiobuf.BlockFrames)
		for i := range samples {
			samples[i] = float32(i%257 + c*300)
		}
		full, err := audiobuf.NewBlock(samples)
		if err != nil {
			t.Fatal(err)
		}
		blocks := make([]*audiobuf.Block, int((frames+audiobuf.BlockFrames-1)/audiobuf.BlockFrames))
		for i := range blocks {
			blocks[i] = full
		}
		blocks[len(blocks)-1], err = audiobuf.NewBlock(samples[:int(frames%audiobuf.BlockFrames)])
		if err != nil {
			t.Fatal(err)
		}
		channels[c], err = audiobuf.NewChannelFromBlocks(blocks)
		if err != nil {
			t.Fatal(err)
		}
	}
	document, err := audiobuf.NewDocument(channels, 48000, audiobuf.Metadata{Name: "hour.wav"})
	if err != nil {
		t.Fatal(err)
	}
	e := New()
	e.document = document
	e.documentSequence = 1
	e.sourceBitDepth = 32
	e.sourceFloat = true
	e.editor = editorState{documentID: "doc-1", selection: protocol.SelectionRange{ChannelMask: 3}}
	e.history, err = newDocumentHistory(document, e.editor)
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func TestHistoryOneHourHundredEditsUnderTwiceUniqueMemory(t *testing.T) {
	e := oneHourHistoryEngine(t)
	initial := e.document
	before := e.documentMemory()
	for i := range 100 {
		start := int64(i * audiobuf.BlockFrames)
		if _, err := e.applyEdit(editParams(e, "mute", start, start+audiobuf.BlockFrames, 3)); err != nil {
			t.Fatal(err)
		}
	}
	retained := e.documentMemory()
	if len(e.historyResult().Entries) != 101 || retained.SampleBytes+retained.PeakBytes >= 2*(before.SampleBytes+before.PeakBytes) {
		t.Fatalf("100 sharedhour edits exceedunique memorytarget: %+v -> %+v", before, retained)
	}
	for range 100 {
		historyNavigate(t, e, protocol.MethodEditUndo, "")
	}
	for c := range 2 {
		wantChannel, err := initial.Channel(c)
		if err != nil {
			t.Fatal(err)
		}
		gotChannel, err := e.document.Channel(c)
		if err != nil {
			t.Fatal(err)
		}
		for _, position := range []int64{0, 17, 99 * audiobuf.BlockFrames, initial.Frames() - 4} {
			want, got := make([]float32, 4), make([]float32, 4)
			if wantChannel.Read(want, position) != gotChannel.Read(got, position) {
				t.Fatal("undo changedduration")
			}
			assertEditBits(t, got, want)
		}
	}
}

func BenchmarkEngineCutPasteHourHistory100(b *testing.B) {
	e := oneHourHistoryEngine(b)
	for range 100 {
		if _, err := e.applyEdit(editParams(e, "swap-channels", 0, 0, 3)); err != nil {
			b.Fatal(err)
		}
	}
	const start, end int64 = 48000*1000 + 17, 48000*2000 + 31
	b.ReportAllocs()
	for b.Loop() {
		if _, err := e.applyEdit(editParams(e, "cut", start, end, 3)); err != nil {
			b.Fatal(err)
		}
		if _, err := e.applyEdit(editParams(e, "paste-insert", start, start, 3)); err != nil {
			b.Fatal(err)
		}
		if e.document.Frames() != 48000*3600 || len(e.historyResult().Entries) != 101 {
			b.Fatal("duration/historylimit changed")
		}
	}
}
