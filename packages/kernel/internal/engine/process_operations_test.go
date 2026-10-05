package engine

import (
	"encoding/binary"
	"encoding/json"
	"math"
	"reflect"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func TestNewProcessesPrivateCommitUndoAndCandidateGeometry(t *testing.T) {
	for _, operation := range []string{"fade-in", "fade-out", "reverse", "invert", "remove-dc", "crossfade", "mono-to-stereo", "stereo-to-mono", "resample", "generate"} {
		t.Run(operation, func(t *testing.T) {
			channels := 2
			if operation == "mono-to-stereo" {
				channels = 1
			}
			input := make([]float32, 12*channels)
			for i := range input {
				input[i] = float32(i+1) / 64
			}
			e, _ := openEditorFixture(t, input, channels)
			setTimelineFixture(t, e, []protocol.TimelineMarker{{ID: 1, Frame: 10, Name: "tail", Color: "#112233"}}, nil)
			before := e.editResult(false)
			p := processParams(e, 2, 8, (1<<channels)-1, 0)
			p.Operation = protocol.OperationName(operation)
			p.Curve = "linear"
			p.ChannelMode = "mix"
			p.SampleRate = 24000
			p.Quality = "balanced"
			p.Generator = "sine"
			p.Frequency = 1000
			p.EndFrequency = 2000
			p.LevelDB = -12
			p.Seed = 21
			p.DurationFrames = 2
			if operation == "crossfade" {
				p.Start = 6
				p.End = 6
			}
			started := startEngineProcess(t, e, p)
			if started.Candidate == nil || started.TotalFrames < 1 {
				t.Fatal("missing initial candidate geometry", started)
			}
			ready := finishEngineNormalization(t, e, started)
			if !reflect.DeepEqual(before, e.editResult(false)) {
				t.Fatal("private processing changed source")
			}
			candidate := ready.Candidate
			if candidate == nil {
				t.Fatal("missing ready geometry")
			}
			if _, err := e.configure(protocol.EngineConfigureParams{SampleRate: 48000, Channels: candidate.Channels}); err != nil {
				t.Fatal(err)
			}
			previewStart, previewEnd := candidate.Start, candidate.End
			if previewStart == previewEnd {
				previewStart, previewEnd = 0, candidate.Frames
			}
			if _, err := e.playDocument(protocol.TransportPlayParams{Start: previewStart, End: &previewEnd, PreviewJobID: ready.JobID}); err != nil {
				t.Fatal("candidate preview format", err)
			}
			if n := e.Render(make([]float32, 128*candidate.Channels)); n == 0 {
				t.Fatal("empty candidate preview")
			}
			committed, err := e.commitProcess(jobParams(ready))
			if err != nil {
				t.Fatal(err)
			}
			if !committed.Changed || !committed.History.Dirty || len(committed.History.Entries) != 2 || committed.Document.SampleRate != candidate.SampleRate || committed.Document.Channels != candidate.Channels || committed.Document.Frames != candidate.Frames || committed.Selection.SelectionRange != candidate.SelectionRange {
				t.Fatal("atomic candidate commit", committed)
			}
			output := editSamples(t, e)
			undo := historyNavigate(t, e, protocol.MethodEditUndo, "")
			assertEditBits(t, editSamples(t, e), input)
			if undo.Document.SampleRate != before.Document.SampleRate || undo.Document.Channels != before.Document.Channels || undo.Selection.SelectionRange != p.SelectionRange {
				t.Fatal("undo lost original format/selection")
			}
			before.Timeline.DocumentID = undo.Document.DocumentID
			if !reflect.DeepEqual(before.Timeline, undo.Timeline) {
				t.Fatal("undo lost annotations")
			}
			redo := historyNavigate(t, e, protocol.MethodEditRedo, "")
			assertEditBits(t, editSamples(t, e), output)
			if redo.Document.SampleRate != candidate.SampleRate || redo.Document.Channels != candidate.Channels {
				t.Fatal("redo lost format")
			}
		})
	}
}

func TestExtractBinaryHandoffExactUnsavedAndFailureAtomic(t *testing.T) {
	input := []float32{1, 10, math.Float32frombits(0x80000000), math.Float32frombits(0x7fc12345), .25, -.5, .75, 1}
	source, _ := openEditorFixture(t, input, 2)
	setTimelineFixture(t, source, []protocol.TimelineMarker{{ID: 1, Frame: 2, Name: "inside", Color: "#123456"}}, []protocol.TimelineRegion{{ID: 2, Start: 0, End: 4, Name: "whole", Color: "#654321"}})
	before := source.editResult(false)
	p := processParams(source, 1, 3, 3, 0)
	p.Operation = "extract-channel"
	p.Channel = 1
	ready := finishEngineNormalization(t, source, startEngineProcess(t, source, p))
	if _, err := source.commitProcess(jobParams(ready)); err == nil {
		t.Fatal("extraction mutated source")
	}
	info, err := source.exportCandidate(jobParams(ready))
	if err != nil {
		t.Fatal(err)
	}
	bytes := source.TakeData()
	if len(bytes) != info.DataBytes || len(bytes) != 8 || info.Channels != 1 || info.Frames != 2 || len(info.Markers) != 1 || info.Markers[0].Frame != 1 || len(info.Regions) != 1 || info.Regions[0].Start != 0 || info.Regions[0].End != 2 {
		t.Fatal("incorrect extraction metadata", info)
	}
	target := New()
	wrong := info.BinaryDocumentParams
	wrong.Frames++
	if _, err := target.importBinaryDocument(wrong, bytes); err == nil || target.doc.document.Channels() != 0 || target.historyState.history != nil {
		t.Fatal("bad import mutated destination")
	}
	imported, err := target.importBinaryDocument(info.BinaryDocumentParams, bytes)
	if err != nil {
		t.Fatal(err)
	}
	assertEditBits(t, editSamples(t, target), []float32{input[3], input[5]})
	if imported.BitDepth != 32 || !imported.Float || !target.historyResult().Dirty || target.historyResult().SavedStateID != "" {
		t.Fatal("new extraction is not an unsaved float document")
	}
	if _, err := target.importBinaryDocument(info.BinaryDocumentParams, bytes); err == nil {
		t.Fatal("handoff replaced an existing destination")
	}
	if _, err := source.cancelProcess(jobParams(ready)); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, source.editResult(false)) {
		t.Fatal("handoff changed source/history")
	}
	if _, err := source.exportCandidate(jobParams(ready)); err == nil {
		t.Fatal("stale extraction exported")
	}
	// The actual ABI carries only scalar metadata and binary bytes.
	raw, _ := json.Marshal(info.BinaryDocumentParams)
	rejected := New()
	response := rejected.CallWithData(protocol.MethodDocumentImportBinary, raw, bytes[:4])
	var envelope protocol.Response
	if json.Unmarshal(response, &envelope) != nil || envelope.OK {
		t.Fatal("ABI accepted truncated audio")
	}
}

func TestBinaryHandoffPublicAPIExactSignalingNaNAndSubnormalBits(t *testing.T) {
	bits := []uint32{0x80000000, 0x00000000, 0x00000001, 0x80000001, 0x7f812345, 0xff812345, 0x7fc12345, 0x3f000000}
	pcm := make([]byte, len(bits)*8)
	for frame, representation := range bits {
		binary.LittleEndian.PutUint32(pcm[frame*8:], 0x3f800000)
		binary.LittleEndian.PutUint32(pcm[frame*8+4:], representation)
	}
	source := New()
	var opened protocol.Response
	if err := json.Unmarshal(source.CallWithData(protocol.MethodDocumentOpen, []byte(`{"name":"bit-patterns.wav"}`), rawWAV(3, 32, 2, 48000, pcm, false)), &opened); err != nil || !opened.OK {
		t.Fatalf("publicopen %v %+v", err, opened)
	}
	var document protocol.DocumentInfoResult
	if err := json.Unmarshal(opened.Result, &document); err != nil {
		t.Fatal(err)
	}
	extract := func(editor *Engine, info protocol.DocumentInfoResult, channel int) (protocol.BinaryDocumentInfo, []byte) {
		t.Helper()
		params := protocol.ProcessStartParams{SelectionResult: protocol.SelectionResult{DocumentID: info.DocumentID, SelectionRange: protocol.SelectionRange{End: info.Frames, ChannelMask: (1 << info.Channels) - 1}}, Operation: "extract-channel", Channel: channel}
		response := editorCall(t, editor, protocol.MethodProcessStart, params)
		if !response.OK {
			t.Fatal(response.Error)
		}
		var job protocol.ProcessJobResult
		if err := json.Unmarshal(response.Result, &job); err != nil {
			t.Fatal(err)
		}
		for job.State == "running" {
			response = editorCall(t, editor, protocol.MethodProcessStepBatch, jobParams(job))
			if !response.OK {
				t.Fatal(response.Error)
			}
			if err := json.Unmarshal(response.Result, &job); err != nil {
				t.Fatal(err)
			}
		}
		if job.State != "ready" || !job.NonFinite || job.Peak != 0.5 {
			t.Fatalf("unsafe exactcandidate telemetry %+v", job)
		}
		response = editorCall(t, editor, protocol.MethodProcessExportCandidate, jobParams(job))
		if !response.OK {
			t.Fatal(response.Error)
		}
		var exported protocol.BinaryDocumentInfo
		if err := json.Unmarshal(response.Result, &exported); err != nil {
			t.Fatal(err)
		}
		return exported, editor.TakeData()
	}
	exported, data := extract(source, document, 1)
	if exported.Channels != 1 || exported.Frames != int64(len(bits)) || exported.DataBytes != len(bits)*4 {
		t.Fatal("wrongpublicbinary geometry")
	}
	for frame, want := range bits {
		if got := binary.LittleEndian.Uint32(data[frame*4:]); got != want {
			t.Fatalf("source frame%d bits%x want%x", frame, got, want)
		}
	}
	metadata, err := json.Marshal(exported.BinaryDocumentParams)
	if err != nil {
		t.Fatal(err)
	}
	target := New()
	var imported protocol.Response
	if err := json.Unmarshal(target.CallWithData(protocol.MethodDocumentImportBinary, metadata, data), &imported); err != nil || !imported.OK {
		t.Fatalf("publicimport %v %+v", err, imported)
	}
	if err := json.Unmarshal(imported.Result, &document); err != nil {
		t.Fatal(err)
	}
	_, echo := extract(target, document, 0)
	if len(echo) != len(data) {
		t.Fatal("roundtrip lengthchanged")
	}
	for frame, want := range bits {
		if got := binary.LittleEndian.Uint32(echo[frame*4:]); got != want {
			t.Fatalf("destination frame%d bits%x want%x", frame, got, want)
		}
	}
}
