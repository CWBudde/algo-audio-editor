package engine

import (
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/history"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	processing "github.com/cwbudde/algo-audio-editor/packages/kernel/internal/process"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func processParams(e *Engine, start, end int64, mask int, gain float64) protocol.ProcessStartParams {
	return protocol.ProcessStartParams{
		SelectionResult: protocol.SelectionResult{DocumentID: e.doc.editor.documentID, SelectionRange: protocol.SelectionRange{Start: start, End: end, ChannelMask: mask}},
		Operation:       "gain", GainDB: gain,
	}
}

func jobParams(result protocol.ProcessJobResult) protocol.ProcessJobParams {
	return protocol.ProcessJobParams{DocumentID: result.DocumentID, JobID: result.JobID}
}

func startEngineProcess(t testing.TB, e *Engine, params protocol.ProcessStartParams) protocol.ProcessJobResult {
	t.Helper()
	result, err := e.startProcess(params, nil)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func finishEngineProcess(t testing.TB, e *Engine, result protocol.ProcessJobResult) protocol.ProcessJobResult {
	t.Helper()
	for result.State == "running" {
		before := result.ProcessedFrames
		var err error
		result, err = e.stepProcess(jobParams(result))
		if err != nil {
			t.Fatal(err)
		}
		if result.ProcessedFrames <= before || result.ProcessedFrames-before > audiobuf.BlockFrames || result.ProcessedFrames > result.TotalFrames {
			t.Fatalf("unbounded or invalid progress %+v", result)
		}
	}
	if result.State != "ready" || result.ProcessedFrames != result.TotalFrames {
		t.Fatalf("incomplete processing %+v", result)
	}
	return result
}

func TestProcessCommitAndHistoryExactSnapshots(t *testing.T) {
	original := []float32{math.Float32frombits(0x80000000), 10, .25, 20, -.5, 30, math.Float32frombits(0x7fa12345), 40}
	e, id := openEditorFixture(t, original, 2)
	if _, err := e.applyEdit(editParams(e, "copy", 0, 1, 3)); err != nil {
		t.Fatal(err)
	}
	setTimelineFixture(t, e, []protocol.TimelineMarker{{ID: 1, Frame: 4, Name: "end", Color: "#112233"}}, []protocol.TimelineRegion{{ID: 2, Start: 1, End: 3, Name: "range", Color: "#334455"}})
	initialHistory, initialTimeline, clip := e.historyResult(), e.timelineResult(), e.clipboardInfo()
	result := startEngineProcess(t, e, processParams(e, 1, 3, 1, 6))
	if _, err := e.commitProcess(jobParams(result)); err == nil {
		t.Fatal("committed incomplete work")
	}
	result = finishEngineProcess(t, e, result)
	assertEditBits(t, editSamples(t, e), original)
	if e.doc.editor.documentID != id || !reflect.DeepEqual(initialHistory, e.historyResult()) || !reflect.DeepEqual(initialTimeline, e.timelineResult()) || e.clipboardInfo() != clip {
		t.Fatal("private processing changed committed state")
	}
	want := append([]float32(nil), original...)
	want[2], want[4] = float32(.25*math.Pow(10, .3)), float32(-.5*math.Pow(10, .3))
	committed, err := e.commitProcess(jobParams(result))
	if err != nil {
		t.Fatal(err)
	}
	assertEditBits(t, editSamples(t, e), want)
	if !committed.Changed || committed.Document.DocumentID == id || len(committed.History.Entries) != 2 || !committed.History.Dirty || committed.Selection.SelectionRange != result.SelectionRange || e.jobs.processJob != nil || e.playback.transport != nil || e.playback.source != sourceStopped || e.clipboardInfo() != clip {
		t.Fatalf("commit invariants %+v", committed)
	}
	if committed.Document.Name != "editor.wav" || committed.Document.BitDepth != 32 || !committed.Document.Float {
		t.Fatal("source format/name changed")
	}
	undone := historyNavigate(t, e, protocol.MethodEditUndo, "")
	assertEditBits(t, editSamples(t, e), original)
	initialTimeline.DocumentID = undone.Document.DocumentID
	if undone.History.Dirty || !reflect.DeepEqual(undone.Timeline, initialTimeline) || undone.Selection.SelectionRange != result.SelectionRange || e.clipboardInfo() != clip {
		t.Fatal("undo lost captured selection/timeline/clipboard")
	}
	historyNavigate(t, e, protocol.MethodEditRedo, "")
	assertEditBits(t, editSamples(t, e), want)
}

func TestProcessPreviewNeverChangesExportAndCancelReleasesMemory(t *testing.T) {
	original := []float32{.25, .5, -.25, -.5}
	e, id := openEditorFixture(t, original, 1)
	if _, err := e.configure(protocol.EngineConfigureParams{SampleRate: 44100, Channels: 1}); err != nil {
		t.Fatal(err)
	}
	initialMemory, initialHistory := e.documentMemory(), e.historyResult()
	result := finishEngineProcess(t, e, startEngineProcess(t, e, processParams(e, 0, 4, 1, 6)))
	if e.documentMemory().SampleBytes <= initialMemory.SampleBytes {
		t.Fatal("ready candidate was missing from memory accounting")
	}
	end := int64(4)
	if _, err := e.playDocument(protocol.TransportPlayParams{Start: 0, End: &end, PreviewJobID: result.JobID}); err != nil {
		t.Fatal(err)
	}
	if e.playback.transport.resampled == nil || e.playback.transport.previewJobID != result.JobID {
		t.Fatal("preview did not use candidate resampling transport")
	}
	if _, err := e.seekDocument(protocol.TransportSeekParams{Frame: 1}); err == nil {
		t.Fatal("seek was allowed while preview job was active")
	}
	if _, err := e.exportDocument(protocol.DocumentExportParams{Format: "wav", BitDepth: 32, Float: true}); err != nil {
		t.Fatal(err)
	}
	other := New()
	if _, err := other.openDocument(protocol.DocumentOpenParams{}, e.TakeData()); err != nil {
		t.Fatal(err)
	}
	assertEditBits(t, editSamples(t, other), original)
	if e.doc.editor.documentID != id || !reflect.DeepEqual(initialHistory, e.historyResult()) {
		t.Fatal("preview dirtied the document")
	}
	cancelled, err := e.cancelProcess(jobParams(result))
	if err != nil || cancelled.State != "cancelled" {
		t.Fatalf("cancel %+v %v", cancelled, err)
	}
	if e.playback.transport != nil || e.jobs.processJob != nil || e.playback.source != sourceStopped || e.documentMemory() != initialMemory {
		t.Fatal("cancel retained preview/workspace memory or audio")
	}
}

func TestProcessPreviewRendersCandidateAndZeroGainKeepsBits(t *testing.T) {
	for _, gain := range []float64{0, 6} {
		t.Run(stringGain(gain), func(t *testing.T) {
			original := []float32{math.Float32frombits(0x80000000), .25, math.Float32frombits(0x7fa12345), float32(math.Inf(1))}
			e, id := openEditorFixture(t, original, 1)
			if _, err := e.configure(protocol.EngineConfigureParams{SampleRate: 48000, Channels: 1}); err != nil {
				t.Fatal(err)
			}
			initialHistory, initialMemory, initialSelection := e.historyResult(), e.documentMemory(), e.doc.editor.selection
			result := finishEngineProcess(t, e, startEngineProcess(t, e, processParams(e, 2, 2, 1, gain)))
			if result.Start != 0 || result.End != 4 || !result.NonFinite || math.IsNaN(result.Peak) || math.IsInf(result.Peak, 0) {
				t.Fatalf("range/stats %+v", result)
			}
			if _, err := json.Marshal(result); err != nil {
				t.Fatal(err)
			}
			if gain == 0 && e.documentMemory().SampleBytes != initialMemory.SampleBytes {
				t.Fatal("identity materialized samples")
			}
			if _, err := e.playDocument(protocol.TransportPlayParams{Start: 0, PreviewJobID: result.JobID}); err != nil {
				t.Fatal(err)
			}
			out := make([]float32, 4)
			if e.Render(out) != 4 || out[1] != float32(.25*math.Pow(10, gain/20)) || math.Float32bits(out[0]) != 0x80000000 || !math.IsNaN(float64(out[2])) || !math.IsInf(float64(out[3]), 1) {
				t.Fatalf("preview output %v", out)
			}
			assertEditBits(t, editSamples(t, e), original)
			committed, err := e.commitProcess(jobParams(result))
			if err != nil {
				t.Fatal(err)
			}
			if gain == 0 {
				assertEditBits(t, editSamples(t, e), original)
				if committed.Changed || e.doc.editor.documentID != id || e.doc.editor.selection != initialSelection || !reflect.DeepEqual(initialHistory, e.historyResult()) || e.documentMemory().SampleBytes != initialMemory.SampleBytes {
					t.Fatal("identity committed audio/history")
				}
			}
		})
	}
}

func stringGain(gain float64) string {
	if gain == 0 {
		return "identity"
	}
	return "gain"
}

func TestProcessLocksMutatingRPCsAndAllowsCommittedReads(t *testing.T) {
	e, id := openEditorFixture(t, []float32{.25, -.5, .75, 1}, 1)
	result := startEngineProcess(t, e, processParams(e, 0, 4, 1, 6))
	for _, state := range []string{"running", "ready"} {
		for _, method := range []string{
			protocol.MethodDocumentOpen, protocol.MethodEditApply, protocol.MethodEditUndo, protocol.MethodEditRedo,
			protocol.MethodHistoryJump, protocol.MethodSelectionSet, protocol.MethodMarkersAdd, protocol.MethodMarkersUpdate,
			protocol.MethodMarkersRemove, protocol.MethodRegionsAdd, protocol.MethodRegionsUpdate, protocol.MethodRegionsRemove,
			protocol.MethodMarkSaved, protocol.MethodToneConfigure, protocol.MethodTransportSeek,
		} {
			if response := editorCall(t, e, method, map[string]any{"documentId": id}); response.OK || !strings.Contains(response.Error, "processing job") {
				t.Fatalf("%s allowed locked %s: %+v", state, method, response)
			}
		}
		for _, method := range []string{protocol.MethodHello, protocol.MethodDocumentInfo, protocol.MethodDocumentMemory, protocol.MethodEditState, protocol.MethodHistoryList, protocol.MethodSelectionGet, protocol.MethodTimelineGet} {
			var params any
			if method == protocol.MethodHistoryList || method == protocol.MethodSelectionGet || method == protocol.MethodTimelineGet {
				params = map[string]any{"documentId": id}
			}
			if response := editorCall(t, e, method, params); !response.OK {
				t.Fatalf("read %s rejected: %s", method, response.Error)
			}
		}
		if response := editorCall(t, e, protocol.MethodTransportPlay, protocol.TransportPlayParams{}); response.OK {
			t.Fatal("ordinary playback accepted during job")
		}
		if response := editorCall(t, e, protocol.MethodEngineConfigure, protocol.EngineConfigureParams{SampleRate: 48000, Channels: 1}); !response.OK {
			t.Fatal(response.Error)
		}
		if response := editorCall(t, e, protocol.MethodTransportStop, nil); !response.OK {
			t.Fatal(response.Error)
		}
		result = finishEngineProcess(t, e, result)
	}
	if _, err := e.cancelProcess(jobParams(result)); err != nil {
		t.Fatal(err)
	}
}

func TestProcessCancelledStepsAndStaleIdentities(t *testing.T) {
	e, _ := openEditorFixture(t, []float32{1, 2, 3, 4}, 1)
	first := startEngineProcess(t, e, processParams(e, 0, 4, 1, 6))
	if _, err := e.cancelProcess(jobParams(first)); err != nil {
		t.Fatal(err)
	}
	second := startEngineProcess(t, e, processParams(e, 0, 4, 1, 3))
	current := e.jobs.processJob
	for _, action := range []func(protocol.ProcessJobParams) (protocol.ProcessJobResult, error){e.stepProcess, e.cancelProcess} {
		result, err := action(jobParams(first))
		if err != nil || result.State != "cancelled" || e.jobs.processJob != current || current.result.ProcessedFrames != 0 {
			t.Fatal("cancelled tombstone changed a newer job")
		}
		for _, bad := range []protocol.ProcessJobParams{{DocumentID: "old", JobID: second.JobID}, {DocumentID: second.DocumentID, JobID: "old"}, {DocumentID: second.DocumentID}} {
			if _, err := action(bad); err == nil || e.jobs.processJob != current {
				t.Fatal("stale request altered the current job")
			}
		}
	}
	if _, err := e.commitProcess(jobParams(first)); err == nil {
		t.Fatal("cancelled job committed")
	}
	if _, err := e.startProcess(processParams(e, 0, 4, 1, 1), nil); err == nil || e.jobs.processJob != current {
		t.Fatal("start replaced active work")
	}
	if _, err := e.cancelProcess(jobParams(second)); err != nil {
		t.Fatal(err)
	}
}

func TestProcessHistoryBudgetAndSourceValidationAreAtomic(t *testing.T) {
	e, _ := openEditorFixture(t, []float32{1, 2, 3, 4}, 1)
	if _, err := e.configure(protocol.EngineConfigureParams{SampleRate: 48000, Channels: 1}); err != nil {
		t.Fatal(err)
	}
	if err := e.historyState.history.SetLimits(history.Limits{MaxEntries: 100, MaxBytes: e.historyState.history.RetainedBytes()}); err != nil {
		t.Fatal(err)
	}
	initial := e.historyResult()
	result := finishEngineProcess(t, e, startEngineProcess(t, e, processParams(e, 0, 4, 1, 6)))
	if _, err := e.playDocument(protocol.TransportPlayParams{PreviewJobID: result.JobID}); err != nil {
		t.Fatal(err)
	}
	job, transport, documentID := e.jobs.processJob, e.playback.transport, e.doc.editor.documentID
	if _, err := e.commitProcess(jobParams(result)); err == nil || !strings.Contains(err.Error(), "budget") {
		t.Fatal("history budget was bypassed")
	}
	if e.jobs.processJob != job || e.playback.transport != transport || e.doc.editor.documentID != documentID || !reflect.DeepEqual(initial, e.historyResult()) {
		t.Fatal("failed history staging published state or stopped preview")
	}
	assertEditBits(t, editSamples(t, e), []float32{1, 2, 3, 4})
	e.doc.documentSequence = math.MaxUint64
	if _, err := e.commitProcess(jobParams(result)); err == nil || e.jobs.processJob != job || e.playback.transport != transport {
		t.Fatal("exhausted document sequence was not atomic")
	}
	e.doc.documentSequence = 1
	job.historyState = "old"
	if _, err := e.commitProcess(jobParams(result)); err == nil || e.jobs.processJob != job {
		t.Fatal("stale history source committed")
	}
	if _, err := e.cancelProcess(jobParams(result)); err != nil {
		t.Fatal("could not release work after stale source rejection", err)
	}
}

func TestProcessStartValidationAndFailureKeepOrdinaryPlayback(t *testing.T) {
	e, _ := openEditorFixture(t, []float32{1, 2, 3, 4}, 1)
	if _, err := e.configure(protocol.EngineConfigureParams{SampleRate: 48000, Channels: 1}); err != nil {
		t.Fatal(err)
	}
	playRange(t, e, 0, 4, true)
	transport, initialHistory := e.playback.transport, e.historyResult()
	for _, params := range []protocol.ProcessStartParams{
		processParams(e, -1, 4, 1, 6), processParams(e, 0, 5, 1, 6), processParams(e, 0, 4, 2, 6),
		processParams(e, 0, 4, 1, math.NaN()), processParams(e, 0, 4, 1, math.Inf(1)),
		processParams(e, 0, 4, 1, -121), processParams(e, 0, 4, 1, 61),
	} {
		if _, err := e.startProcess(params, nil); err == nil || e.jobs.processJob != nil || e.playback.transport != transport || !transport.playing {
			t.Fatal("invalid start changed playback/job state")
		}
	}
	result := startEngineProcess(t, e, processParams(e, 0, 4, 1, 6))
	if _, err := e.cancelProcess(jobParams(result)); err != nil || e.playback.transport != transport || !transport.playing {
		t.Fatal("cancel stopped ordinary playback")
	}
	result = startEngineProcess(t, e, processParams(e, 0, 4, 1, 6))
	e.jobs.processJob.builder.Cancel()
	failing, err := processing.NewBuilder(e.doc.document, ops.Range{Start: 0, End: 4, ChannelMask: 1}, engineFailingProcess{}, processing.Limits{})
	if err != nil {
		t.Fatal(err)
	}
	e.jobs.processJob.builder = failing
	if _, err := e.stepProcess(jobParams(result)); err == nil || e.jobs.processJob != nil || e.playback.transport != transport || !transport.playing || !reflect.DeepEqual(initialHistory, e.historyResult()) {
		t.Fatal("processing failure changed committed state or retained workspace")
	}
}

type engineFailingProcess struct{}

func (engineFailingProcess) NewChannel(int, int, int64) (processing.Processor, error) {
	return engineFailingProcessor{}, nil
}

type engineFailingProcessor struct{}

func (engineFailingProcessor) ProcessBlock([]float64) error {
	return errors.New("injected processing failure")
}

func TestProcessEightChannelsAndPartialMemory(t *testing.T) {
	frames := audiobuf.BlockFrames + 7
	original := make([]float32, frames*8)
	for frame := range frames {
		for channel := range 8 {
			original[frame*8+channel] = float32(channel+1) / 16
		}
	}
	e, _ := openEditorFixture(t, original, 8)
	initialMemory := e.documentMemory()
	result := startEngineProcess(t, e, processParams(e, 1, int64(frames-1), 129, 6))
	result, err := e.stepProcess(jobParams(result))
	if err != nil || result.State != "running" || result.ProcessedFrames != audiobuf.BlockFrames {
		t.Fatalf("first slice %+v %v", result, err)
	}
	if e.documentMemory().SampleBytes != initialMemory.SampleBytes+2*audiobuf.BlockFrames*4 {
		t.Fatal("partial output was not counted once")
	}
	result = finishEngineProcess(t, e, result)
	if _, err := e.commitProcess(jobParams(result)); err != nil {
		t.Fatal(err)
	}
	want := append([]float32(nil), original...)
	for frame := 1; frame < frames-1; frame++ {
		for _, channel := range []int{0, 7} {
			want[frame*8+channel] = float32(float64(original[frame*8+channel]) * math.Pow(10, .3))
		}
	}
	assertEditBits(t, editSamples(t, e), want)
}

func TestProcessRPCLifecycleAndFiniteProgress(t *testing.T) {
	e, _ := openEditorFixture(t, []float32{math.MaxFloat32, float32(math.NaN()), -.25}, 1)
	response := editorCall(t, e, protocol.MethodProcessStart, processParams(e, 0, 3, 1, 60))
	var result protocol.ProcessJobResult
	if !response.OK {
		t.Fatal(response.Error)
	}
	if err := json.Unmarshal(response.Result, &result); err != nil {
		t.Fatal(err)
	}
	response = editorCall(t, e, protocol.MethodProcessStep, jobParams(result))
	if !response.OK {
		t.Fatal(response.Error)
	}
	if err := json.Unmarshal(response.Result, &result); err != nil {
		t.Fatal(err)
	}
	if result.State != "ready" || !result.NonFinite || math.IsNaN(result.Peak) || math.IsInf(result.Peak, 0) {
		t.Fatalf("unsafe progress %+v", result)
	}
	response = editorCall(t, e, protocol.MethodProcessCancel, jobParams(result))
	if !response.OK {
		t.Fatal(response.Error)
	}
	response = editorCall(t, e, protocol.MethodProcessStep, jobParams(result))
	if !response.OK {
		t.Fatal("queued step did not receive cancellation", response.Error)
	}
	if err := json.Unmarshal(response.Result, &result); err != nil || result.State != "cancelled" || result.ProcessedFrames != 3 || !result.NonFinite {
		t.Fatalf("cancelled telemetry %+v %v", result, err)
	}
	result = finishEngineProcess(t, e, startEngineProcess(t, e, processParams(e, 2, 3, 1, -6)))
	response = editorCall(t, e, protocol.MethodProcessCommit, jobParams(result))
	var edited protocol.EditResult
	if !response.OK {
		t.Fatal(response.Error)
	}
	if err := json.Unmarshal(response.Result, &edited); err != nil || !edited.Changed || !edited.History.Dirty {
		t.Fatalf("commit reply %+v %v", edited, err)
	}
	if len(e.TakeData()) != 0 {
		t.Fatal("job control exposed bulk data")
	}
}

func TestProcessCollapsedRangeUndoRestoresOriginalCursor(t *testing.T) {
	e, _ := openEditorFixture(t, []float32{.25, -.5, .75, 1}, 1)
	cursor := protocol.SelectionRange{Start: 2, End: 2, ChannelMask: 1}
	if _, err := e.setSelection(protocol.SelectionSetParams{DocumentID: e.doc.editor.documentID, SelectionRange: cursor}); err != nil {
		t.Fatal(err)
	}
	result := finishEngineProcess(t, e, startEngineProcess(t, e, processParams(e, 2, 2, 1, 6)))
	if _, err := e.commitProcess(jobParams(result)); err != nil {
		t.Fatal(err)
	}
	if e.doc.editor.selection.Start != 0 || e.doc.editor.selection.End != 4 {
		t.Fatal("commit did not publish the processed whole range")
	}
	undone := historyNavigate(t, e, protocol.MethodEditUndo, "")
	if undone.Selection.SelectionRange != cursor {
		t.Fatal("undo lost the explicit collapsed cursor")
	}
}

func TestProcessEmptyDocumentAndIdentitySequenceGuard(t *testing.T) {
	e, _ := openEditorFixture(t, nil, 1)
	if _, err := e.startProcess(processParams(e, 0, 0, 1, 6), nil); err == nil || e.jobs.processJob != nil {
		t.Fatal("processing accepted an empty document")
	}
	e, _ = openEditorFixture(t, []float32{.25}, 1)
	e.jobs.processSequence = math.MaxUint64
	if _, err := e.startProcess(processParams(e, 0, 1, 1, 6), nil); err == nil || e.jobs.processJob != nil {
		t.Fatal("job sequence wrapped")
	}
	p := processParams(e, 0, 1, 1, 6)
	p.Operation = "unsupported"
	e.jobs.processSequence = 0
	if _, err := e.startProcess(p, nil); err == nil || e.jobs.processSequence != 0 {
		t.Fatal("unsupported operation consumed an identity")
	}
}

func logicalProcessDocument(t testing.TB, frames int64, channels int) audiobuf.Document {
	t.Helper()
	samples := make([]float32, audiobuf.BlockFrames)
	for i := range samples {
		samples[i] = .125
	}
	block, err := audiobuf.NewBlock(samples)
	if err != nil {
		t.Fatal(err)
	}
	blocks := make([]*audiobuf.Block, frames/audiobuf.BlockFrames)
	for i := range blocks {
		blocks[i] = block
	}
	if tail := int(frames % audiobuf.BlockFrames); tail > 0 {
		last, err := audiobuf.NewBlock(samples[:tail])
		if err != nil {
			t.Fatal(err)
		}
		blocks = append(blocks, last)
	}
	channel, err := audiobuf.NewChannelFromBlocks(blocks)
	if err != nil {
		t.Fatal(err)
	}
	views := make([]audiobuf.Channel, channels)
	for i := range views {
		views[i] = channel
	}
	document, err := audiobuf.NewDocument(views, 48000, audiobuf.Metadata{Name: "logical.wav"})
	if err != nil {
		t.Fatal(err)
	}
	return document
}

func processEngineWithDocument(t testing.TB, document audiobuf.Document) *Engine {
	t.Helper()
	e := New()
	e.doc.document, e.doc.documentSequence, e.doc.sourceBitDepth, e.doc.sourceFloat = document, 1, 32, true
	e.doc.editor = editorState{documentID: "doc-1", selection: protocol.SelectionRange{ChannelMask: (1 << document.Channels()) - 1}}
	var err error
	e.historyState.history, err = newDocumentHistory(document, e.doc.editor)
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func TestProcessOutputBudgetRejectsLogicalLargeInputBeforeAllocating(t *testing.T) {
	document := logicalProcessDocument(t, int64(maxProcessOutputBytes/4)+1, 1)
	e := processEngineWithDocument(t, document)
	before, memory := e.editResult(false), e.documentMemory()
	if _, err := e.startProcess(processParams(e, 0, document.Frames(), 1, 6), nil); err == nil || !strings.Contains(err.Error(), "budget") {
		t.Fatal("materialization budget was bypassed")
	}
	if e.jobs.processJob != nil || e.jobs.processSequence != 0 || !reflect.DeepEqual(before, e.editResult(false)) || e.documentMemory() != memory {
		t.Fatal("rejected materialization altered engine state")
	}
	identity := startEngineProcess(t, e, processParams(e, 0, document.Frames(), 1, 0))
	if _, err := e.cancelProcess(jobParams(identity)); err != nil || e.documentMemory() != memory {
		t.Fatal("large storage identity allocated materialized output")
	}
}

func TestProcessPreviewRenderAllocations(t *testing.T) {
	e, _ := openEditorFixture(t, []float32{.25, -.5, .75, 1}, 1)
	if _, err := e.configure(protocol.EngineConfigureParams{SampleRate: 44100, Channels: 1}); err != nil {
		t.Fatal(err)
	}
	result := finishEngineProcess(t, e, startEngineProcess(t, e, processParams(e, 0, 4, 1, 6)))
	if _, err := e.playDocument(protocol.TransportPlayParams{PreviewJobID: result.JobID, Loop: true}); err != nil {
		t.Fatal(err)
	}
	out, positions := make([]float32, 128), make([]int64, 128)
	if allocations := testing.AllocsPerRun(100, func() { e.RenderWithPositions(out, positions) }); allocations != 0 {
		t.Fatalf("preview render allocated %v", allocations)
	}
}

func BenchmarkEngineProcessTenMinuteStereo(b *testing.B) {
	document := logicalProcessDocument(b, 48000*600, 2)
	b.ReportAllocs()
	b.SetBytes(document.Frames() * 2 * 4)
	b.ResetTimer()
	for range b.N {
		b.StopTimer()
		e := processEngineWithDocument(b, document)
		b.StartTimer()
		result := finishEngineProcess(b, e, startEngineProcess(b, e, processParams(e, 0, document.Frames(), 3, 6)))
		if _, err := e.commitProcess(jobParams(result)); err != nil {
			b.Fatal(err)
		}
	}
}
