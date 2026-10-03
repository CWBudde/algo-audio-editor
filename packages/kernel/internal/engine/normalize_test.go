package engine

import (
	"encoding/json"
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/history"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func normalizationParams(e *Engine, start, end int64, mask int, operation string, target float64) protocol.ProcessStartParams {
	params := processParams(e, start, end, mask, 0)
	params.Operation, params.Target = operation, &target
	return params
}

func finishEngineNormalization(t testing.TB, e *Engine, result protocol.ProcessJobResult) protocol.ProcessJobResult {
	t.Helper()
	for attempts := 0; result.State == "running" && attempts < 50000; attempts++ {
		before := result
		var err error
		result, err = e.stepProcess(jobParams(result))
		if err != nil {
			t.Fatal(err)
		}
		if result.PhaseIndex < before.PhaseIndex || result.PhaseIndex >= result.PhaseCount || result.PlanningSteps < before.PlanningSteps || result.ProcessedFrames > result.TotalFrames || result.InputPeak < before.InputPeak {
			t.Fatalf("invalid phase-aware progress: %+v", result)
		}
		if result.PhaseIndex == before.PhaseIndex && result.ProcessedFrames < before.ProcessedFrames {
			t.Fatal("same-phase progress regressed")
		}
		if result.Operation != before.Operation || result.DocumentID != before.DocumentID || result.JobID != before.JobID || result.TotalFrames != before.TotalFrames {
			t.Fatal("fixed processing identity changed")
		}
	}
	if result.State != "ready" || !result.GainResolved || result.ProcessedFrames != result.TotalFrames || result.PhaseIndex != result.PhaseCount-1 {
		t.Fatalf("normalization failed to become ready: %+v", result)
	}
	return result
}

func TestNormalizeEnginePeakPreviewExportAndExactUndo(t *testing.T) {
	original := []float32{.5, 1, -.25, -2, math.Float32frombits(0x80000000), 0, .125, .25}
	want := []float32{.25, .5, -.125, -1, math.Float32frombits(0x80000000), 0, .0625, .125}
	e, id := openEditorFixture(t, original, 2)
	if _, err := e.configure(protocol.EngineConfigureParams{SampleRate: 48000, Channels: 2}); err != nil {
		t.Fatal(err)
	}
	cursor := protocol.SelectionRange{Start: 1, End: 1, ChannelMask: 3}
	if _, err := e.applyEdit(editParams(e, "copy", 0, 1, 3)); err != nil {
		t.Fatal(err)
	}
	e.editor.selection = cursor
	setTimelineFixture(t, e, []protocol.TimelineMarker{{ID: 1, Frame: 2, Name: "mid", Color: "#112233"}}, []protocol.TimelineRegion{{ID: 2, Start: 0, End: 4, Name: "whole", Color: "#445566"}})
	baseline, memory, clipboard := e.editResult(false), e.documentMemory(), e.clipboardInfo()
	result := startEngineProcess(t, e, normalizationParams(e, 1, 1, 3, "normalize-peak", 0))
	if result.Phase != "analyzing" || result.GainResolved || result.GainDB != 0 || result.PhaseCount != 2 || result.PhaseIndex != 0 || e.documentMemory() != memory {
		t.Fatalf("analysis allocated/published output or invented gain: %+v", result)
	}
	first, err := e.stepProcess(jobParams(result))
	if err != nil || first.GainResolved || first.Peak != 0 || first.InputPeak != 2 || e.documentMemory() != memory {
		t.Fatalf("analysis changed output/memory: %+v %v", first, err)
	}
	result = finishEngineNormalization(t, e, first)
	assertEditBits(t, editSamples(t, e), original)
	if !reflect.DeepEqual(e.editResult(false), baseline) || result.Peak != 1 || result.InputLUFS != nil || result.PredictedLUFS != nil || result.OutputLUFS != nil {
		t.Fatal("private peak job changed source/history or invented loudness")
	}
	if _, err := e.playDocument(protocol.TransportPlayParams{PreviewJobID: result.JobID}); err != nil {
		t.Fatal(err)
	}
	preview := make([]float32, len(original))
	if frames := e.Render(preview); frames != 4 {
		t.Fatalf("preview frames=%d, want4", frames)
	}
	assertEditBits(t, preview, want)
	if _, err := e.exportDocument(protocol.DocumentExportParams{Format: "wav", BitDepth: 32, Float: true}); err != nil {
		t.Fatal(err)
	}
	exported := New()
	if _, err := exported.openDocument(protocol.DocumentOpenParams{}, e.TakeData()); err != nil {
		t.Fatal(err)
	}
	assertEditBits(t, editSamples(t, exported), original)
	committed, err := e.commitProcess(jobParams(result))
	if err != nil {
		t.Fatal(err)
	}
	assertEditBits(t, editSamples(t, e), want)
	if !committed.Changed || committed.Document.DocumentID == id || committed.History.Entries[len(committed.History.Entries)-1].Label != "Normalize peak" || e.source != sourceStopped || e.transport != nil || e.clipboardInfo() != clipboard {
		t.Fatal("normalization commit lost publication/history/transport invariants")
	}
	undone := historyNavigate(t, e, protocol.MethodEditUndo, "")
	assertEditBits(t, editSamples(t, e), original)
	if undone.Selection.SelectionRange != cursor || e.clipboardInfo() != clipboard {
		t.Fatal("undo did not restore original collapsed UI selection")
	}
	baseline.Timeline.DocumentID = undone.Document.DocumentID
	if !reflect.DeepEqual(undone.Timeline, baseline.Timeline) {
		t.Fatal("length-preserving normalization shifted anchors")
	}
	historyNavigate(t, e, protocol.MethodEditRedo, "")
	assertEditBits(t, editSamples(t, e), want)
}

func TestNormalizeEngineSilentAndResolvedIdentityDoNotDirty(t *testing.T) {
	for _, operation := range []string{"normalize-peak", "normalize-loudness"} {
		t.Run(operation, func(t *testing.T) {
			input := make([]float32, 19200)
			input[41] = math.Float32frombits(0x80000000)
			e, _ := openEditorFixture(t, input, 1)
			e.editor.selection = protocol.SelectionRange{Start: 41, End: 41, ChannelMask: 1}
			before, memory := e.editResult(false), e.documentMemory()
			result := finishEngineNormalization(t, e, startEngineProcess(t, e, normalizationParams(e, 41, 41, 1, operation, -23)))
			// An identity candidate adds references to existing blocks, not new
			// sample/peak storage. Both committed and private snapshots count.
			candidateMemory := memory
			candidateMemory.BlockReferences += audiobuf.CountMemory(e.document).BlockReferences
			if result.UnchangedReason != "silent" || result.InputPeak != 0 || result.Peak != 0 || e.documentMemory() != candidateMemory {
				t.Fatalf("silent candidate invented gain/storage: %+v memory=%+v want=%+v", result, e.documentMemory(), candidateMemory)
			}
			assertEditBits(t, editSamples(t, e), input)
			if !reflect.DeepEqual(before, e.editResult(false)) {
				t.Fatal("ready silent identity changed committed metadata/history/selection")
			}
			committed, err := e.commitProcess(jobParams(result))
			if err != nil || committed.Changed || !reflect.DeepEqual(before, e.editResult(false)) || e.documentMemory() != memory {
				t.Fatal("silent commit changed selection/docID/history/memory", err)
			}
			assertEditBits(t, editSamples(t, e), input)
		})
	}
	e, _ := openEditorFixture(t, []float32{1, -.5, 0}, 1)
	before := e.editResult(false)
	result := finishEngineNormalization(t, e, startEngineProcess(t, e, normalizationParams(e, 0, 3, 1, "normalize-peak", 0)))
	if _, err := e.commitProcess(jobParams(result)); err != nil || !reflect.DeepEqual(before, e.editResult(false)) {
		t.Fatal("resolved factor-one normalization created an edit", err)
	}
}

func TestNormalizeEngineValidationAndSelectedNonfiniteAtomicity(t *testing.T) {
	e, _ := openEditorFixture(t, []float32{.5, -.25}, 1)
	baseline := e.editResult(false)
	for _, test := range []struct {
		operation string
		target    *float64
	}{
		{"normalize-peak", nil},
		{"normalize-loudness", nil},
		{"normalize-peak", normalizeTarget(-121)},
		{"normalize-peak", normalizeTarget(.1)},
		{"normalize-loudness", normalizeTarget(-70)},
		{"normalize-loudness", normalizeTarget(.1)},
		{"normalize-peak", normalizeTarget(math.NaN())},
		{"normalize-loudness", normalizeTarget(math.Inf(1))},
	} {
		params := processParams(e, 0, 2, 1, 0)
		params.Operation, params.Target = test.operation, test.target
		if _, err := e.startProcess(params); err == nil {
			t.Fatalf("invalid normalization parameters accepted: %+v", params)
		}
	}
	if e.processSequence != 0 || !reflect.DeepEqual(baseline, e.editResult(false)) {
		t.Fatal("invalid start changed job sequence or committed state")
	}
	for _, value := range []float32{float32(math.NaN()), float32(math.Inf(1))} {
		e, _ := openEditorFixture(t, []float32{.5, value}, 1)
		before, memory := e.editResult(false), e.documentMemory()
		result := startEngineProcess(t, e, normalizationParams(e, 0, 2, 1, "normalize-peak", 0))
		if _, err := e.stepProcess(jobParams(result)); err == nil || !strings.Contains(err.Error(), "finite") {
			t.Fatal("nonfinite source normalized")
		}
		if e.processJob != nil || !reflect.DeepEqual(before, e.editResult(false)) || e.documentMemory() != memory {
			t.Fatal("failed source analysis altered committed state")
		}
	}
}

func normalizeTarget(value float64) *float64 { return &value }

func TestNormalizeEnginePhaseCancellationAndRPCLocks(t *testing.T) {
	for _, phase := range []string{"analyzing", "processing", "verifying"} {
		t.Run(phase, func(t *testing.T) {
			input := make([]float32, 24000)
			for i := range input {
				input[i] = float32(.25 * math.Sin(2*math.Pi*1000*float64(i)/48000))
			}
			e, _ := openEditorFixture(t, input, 1)
			before, memory := e.editResult(false), e.documentMemory()
			result := startEngineProcess(t, e, normalizationParams(e, 0, int64(len(input)), 1, "normalize-loudness", -23))
			for attempts := 0; result.Phase != phase && attempts < 1000; attempts++ {
				var err error
				result, err = e.stepProcess(jobParams(result))
				if err != nil {
					t.Fatal(err)
				}
			}
			if result.Phase != phase || result.State != "running" {
				t.Fatal("cancellable phase was skipped")
			}
			for _, method := range []string{protocol.MethodDocumentOpen, protocol.MethodEditApply, protocol.MethodSelectionSet, protocol.MethodMarkersAdd, protocol.MethodMarkSaved, protocol.MethodEditUndo, protocol.MethodTransportSeek} {
				if response := editorCall(t, e, method, nil); response.OK || !strings.Contains(response.Error, "processing job") {
					t.Fatalf("mutation %s bypassed %s lock", method, phase)
				}
			}
			cancelled, err := e.cancelProcess(jobParams(result))
			if err != nil || cancelled.PhaseIndex != result.PhaseIndex || cancelled.ProcessedFrames != result.ProcessedFrames || cancelled.PlanningSteps != result.PlanningSteps {
				t.Fatal("cancel reset progress telemetry", err)
			}
			if e.processJob != nil || !reflect.DeepEqual(before, e.editResult(false)) || e.documentMemory() != memory {
				t.Fatal("cancel retained staged samples or changed source")
			}
			if reply, err := e.stepProcess(jobParams(result)); err != nil || reply.State != "cancelled" {
				t.Fatal("queued step did not observe terminal tombstone", err)
			}
		})
	}
}

func TestNormalizeEngineRequiredABIFieldsAndSubnormalGain(t *testing.T) {
	e, _ := openEditorFixture(t, []float32{math.Float32frombits(1), math.Float32frombits(2)}, 1)
	params := normalizationParams(e, 0, 2, 1, "normalize-peak", 0)
	payload, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	response := e.Call(protocol.MethodProcessStart, payload)
	for _, key := range []string{"\"phase\"", "\"phaseIndex\"", "\"phaseCount\"", "\"planningSteps\"", "\"gainResolved\"", "\"inputPeak\"", "\"inputLufs\":null", "\"predictedLufs\":null", "\"outputLufs\":null"} {
		if !strings.Contains(string(response), key) {
			t.Fatalf("missing required ABI9 metadata %s: %s", key, response)
		}
	}
	var envelope struct {
		OK     bool                      `json:"ok"`
		Result protocol.ProcessJobResult `json:"result"`
	}
	if err := json.Unmarshal(response, &envelope); err != nil || !envelope.OK {
		t.Fatal("ABI9 process.start failed", err)
	}
	result := finishEngineNormalization(t, e, envelope.Result)
	if result.GainDB < 800 || result.Peak != 1 || result.NonFinite {
		t.Fatalf("finite subnormal gain was clipped: %+v", result)
	}
	if _, err := e.commitProcess(jobParams(result)); err != nil {
		t.Fatal(err)
	}
	assertEditBits(t, editSamples(t, e), []float32{.5, 1})
}

func TestProcessRawWireNullableMetricsMatchTypeScriptNames(t *testing.T) {
	for _, operation := range []string{"gain", "normalize-peak", "normalize-loudness"} {
		t.Run(operation, func(t *testing.T) {
			e, _ := openEditorFixture(t, []float32{.5, -.25}, 1)
			params := processParams(e, 0, 2, 1, 6)
			if operation != "gain" {
				params = normalizationParams(e, 0, 2, 1, operation, -23)
			}
			payload, err := json.Marshal(params)
			if err != nil {
				t.Fatal(err)
			}
			// Decode only generic JSON, not Go's mirrored result type: matching
			// incorrect Go field tags must not conceal a browser wire mismatch.
			var response map[string]json.RawMessage
			if err := json.Unmarshal(e.Call(protocol.MethodProcessStart, payload), &response); err != nil || string(response["ok"]) != "true" {
				t.Fatal("raw process.start failed", err)
			}
			var result map[string]json.RawMessage
			if err := json.Unmarshal(response["result"], &result); err != nil {
				t.Fatal(err)
			}
			for _, name := range []string{"inputLufs", "predictedLufs", "outputLufs"} {
				if value, exists := result[name]; !exists || string(value) != "null" {
					t.Fatalf("browser-required nullable field %s absent/non-null: %s", name, response["result"])
				}
			}
			for _, name := range []string{"inputLUFS", "predictedLUFS", "outputLUFS"} {
				if _, exists := result[name]; exists {
					t.Fatalf("incorrect acronym-cased wire field %s emitted", name)
				}
			}
		})
	}
}

func TestNormalizeEngineHistoryBudgetKeepsReadyCandidateAndPreviewAtomic(t *testing.T) {
	original := []float32{2, -1, .5, 0}
	e, _ := openEditorFixture(t, original, 1)
	if _, err := e.configure(protocol.EngineConfigureParams{SampleRate: 48000, Channels: 1}); err != nil {
		t.Fatal(err)
	}
	if err := e.history.SetLimits(history.Limits{MaxEntries: 100, MaxBytes: e.history.RetainedBytes()}); err != nil {
		t.Fatal(err)
	}
	before, memory := e.editResult(false), e.documentMemory()
	result := finishEngineNormalization(t, e, startEngineProcess(t, e, normalizationParams(e, 0, 4, 1, "normalize-peak", 0)))
	if _, err := e.playDocument(protocol.TransportPlayParams{PreviewJobID: result.JobID}); err != nil {
		t.Fatal(err)
	}
	job, transport := e.processJob, e.transport
	if _, err := e.commitProcess(jobParams(result)); err == nil || !strings.Contains(err.Error(), "budget") {
		t.Fatal("normalization bypassed undo budget")
	}
	if e.processJob != job || e.transport != transport || !reflect.DeepEqual(before, e.editResult(false)) {
		t.Fatal("failed normalization commit published state or invalidated its private preview")
	}
	assertEditBits(t, editSamples(t, e), original)
	if _, err := e.cancelProcess(jobParams(result)); err != nil || e.documentMemory() != memory || e.transport != nil {
		t.Fatal("budget-failed ready candidate could not be cancelled/released", err)
	}
}

func BenchmarkEngineNormalizeTenMinuteStereo(b *testing.B) {
	const frames = 48000 * 600
	input := make([]float32, audiobuf.BlockFrames)
	for i := range input {
		input[i] = float32(i%31-15) / 128
	}
	block, err := audiobuf.NewBlock(input)
	if err != nil {
		b.Fatal(err)
	}
	blocks := make([]*audiobuf.Block, frames/audiobuf.BlockFrames)
	for i := range blocks {
		blocks[i] = block
	}
	channel, err := audiobuf.NewChannelFromBlocks(blocks)
	if err != nil {
		b.Fatal(err)
	}
	channel = channel.Concat(audiobuf.NewChannel(input[:frames%audiobuf.BlockFrames]))
	document, err := audiobuf.NewDocument([]audiobuf.Channel{channel, channel}, 48000, audiobuf.Metadata{Name: "ten-minute.wav"})
	if err != nil {
		b.Fatal(err)
	}
	for _, operation := range []string{"normalize-peak", "normalize-loudness"} {
		b.Run(operation, func(b *testing.B) {
			target := -6.0
			if operation == "normalize-loudness" {
				target = -23
			}
			b.ReportAllocs()
			b.SetBytes(document.Frames() * 2 * 4)
			b.ResetTimer()
			for range b.N {
				b.StopTimer()
				e := processEngineWithDocument(b, document)
				b.StartTimer()
				result := finishEngineNormalization(b, e, startEngineProcess(b, e, normalizationParams(e, 0, document.Frames(), 3, operation, target)))
				if _, err := e.commitProcess(jobParams(result)); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
