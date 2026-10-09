package engine

import (
	"encoding/binary"
	"encoding/json"
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func pcmBytes(samples []float32) []byte {
	out := make([]byte, 4*len(samples))
	for i, v := range samples {
		binary.LittleEndian.PutUint32(out[4*i:], math.Float32bits(v))
	}
	return out
}

func audioParams(e *Engine, start, end int64, mask, rate int) protocol.ProcessStartParams {
	return protocol.ProcessStartParams{
		SelectionResult: protocol.SelectionResult{DocumentID: e.doc.editor.documentID, SelectionRange: protocol.SelectionRange{Start: start, End: end, ChannelMask: mask}},
		Operation:       protocol.OperationGenerate, Generator: protocol.GeneratorAudio, SourceSampleRate: rate,
	}
}

// callProcessStart sends process.start over the wire entry point with the
// given binary input, as the worker bridge and native runners do.
func callProcessStart(t *testing.T, e *Engine, params protocol.ProcessStartParams, input []byte) (protocol.ProcessJobResult, string) {
	t.Helper()
	payload, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	var response protocol.Response
	if err := json.Unmarshal(e.CallWithData(protocol.MethodProcessStart, payload, input), &response); err != nil {
		t.Fatal(err)
	}
	if !response.OK {
		return protocol.ProcessJobResult{}, response.Error
	}
	var result protocol.ProcessJobResult
	if err := json.Unmarshal(response.Result, &result); err != nil {
		t.Fatal(err)
	}
	return result, ""
}

func TestAudioGeneratorCommitsOneUndoableEdit(t *testing.T) {
	original := []float32{1, 5, 2, 6, 3, 7, 4, 8}
	e, _ := openEditorFixture(t, original, 2)
	speech := []float32{0.1, 0.2, 0.3}
	job, failure := callProcessStart(t, e, audioParams(e, 1, 3, 3, 48000), pcmBytes(speech))
	if failure != "" {
		t.Fatal(failure)
	}
	job = finishEngineProcess(t, e, job)
	if job.Candidate == nil || job.Candidate.Frames != 5 || job.Candidate.Start != 1 || job.Candidate.End != 4 {
		t.Fatalf("candidate geometry %+v, want 5 frames selecting 1..4", job.Candidate)
	}
	if _, err := e.commitProcess(jobParams(job)); err != nil {
		t.Fatal(err)
	}
	want := []float32{1, 5, 0.1, 0.1, 0.2, 0.2, 0.3, 0.3, 4, 8}
	if got := editSamples(t, e); !reflect.DeepEqual(got, want) {
		t.Fatalf("samples %v, want %v", got, want)
	}
	if e.doc.editor.selection != (protocol.SelectionRange{Start: 1, End: 4, ChannelMask: 3}) {
		t.Fatalf("selection %+v, want the speech", e.doc.editor.selection)
	}
	historyNavigate(t, e, protocol.MethodEditUndo, "")
	if got := editSamples(t, e); !reflect.DeepEqual(got, original) {
		t.Fatalf("undo restored %v, want %v", got, original)
	}
}

func TestAudioGeneratorFillsAnEmptyDocument(t *testing.T) {
	e, _ := openEditorFixture(t, nil, 1)
	job, failure := callProcessStart(t, e, audioParams(e, 0, 0, 1, 24000), pcmBytes(make([]float32, 2400)))
	if failure != "" {
		t.Fatal(failure)
	}
	job = finishEngineProcess(t, e, job)
	if _, err := e.commitProcess(jobParams(job)); err != nil {
		t.Fatal(err)
	}
	if e.doc.document.Frames() != 4800 {
		t.Fatalf("frames %d, want 0.1 s at 48 kHz", e.doc.document.Frames())
	}
}

func TestProcessStartBinaryInputNeedsTheAudioGenerator(t *testing.T) {
	e, _ := openEditorFixture(t, []float32{1, 2, 3, 4}, 1)
	gain := processParams(e, 0, 4, 1, -6)
	sine := audioParams(e, 0, 0, 1, 0)
	sine.Generator, sine.DurationFrames, sine.Frequency = "sine", 4, 440
	sineWithRate := sine
	sineWithRate.SourceSampleRate = 24000
	tests := []struct {
		name   string
		params protocol.ProcessStartParams
		input  []byte
		want   string
	}{
		{"gain with input", gain, pcmBytes([]float32{1}), "need the audio generator"},
		{"sine with input", sine, pcmBytes([]float32{1}), "need the audio generator"},
		{"sine with a source rate", sineWithRate, nil, "need the audio generator"},
		{"audio without input", audioParams(e, 0, 0, 1, 24000), nil, "needs mono float32 PCM"},
		{"audio with a partial sample", audioParams(e, 0, 0, 1, 24000), []byte{0, 0, 0}, "needs mono float32 PCM"},
		{"audio without a rate", audioParams(e, 0, 0, 1, 0), pcmBytes([]float32{1}), "audio rate"},
		{"audio with NaN", audioParams(e, 0, 0, 1, 48000), pcmBytes([]float32{float32(math.NaN())}), "finite"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, failure := callProcessStart(t, e, tc.params, tc.input)
			if !strings.HasPrefix(failure, protocol.MethodProcessStart+":") || !strings.Contains(failure, tc.want) {
				t.Fatalf("process.start failure %q, want a process.start error containing %q", failure, tc.want)
			}
			if e.jobs.processJob != nil {
				t.Fatal("rejected start left a job behind")
			}
		})
	}
}
