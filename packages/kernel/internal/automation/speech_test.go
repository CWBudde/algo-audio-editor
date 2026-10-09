//go:build !js

package automation

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/engine"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/speech"
	pockettts "github.com/cwbudde/go-pocket-tts"
)

// fakeSpeaker returns frames of constant speech and records the requests.
type fakeSpeaker struct {
	frames   int
	requests []protocol.SpeechGenerateParams
}

func (f *fakeSpeaker) Synthesize(_ context.Context, p protocol.SpeechGenerateParams) ([]float32, error) {
	f.requests = append(f.requests, p)
	pcm := make([]float32, f.frames)
	for i := range pcm {
		pcm[i] = 0.25
	}
	return pcm, nil
}

func speechStep(extra map[string]any) Operation {
	params := map[string]any{"model": "german", "voice": "juergen", "text": "Guten Tag.", "temperature": 0.3, "samplerSteps": 1, "eosThreshold": -4, "seed": 7}
	for key, value := range extra {
		params[key] = value
	}
	return Operation{Method: protocol.ChainSpeechGenerate, Params: params}
}

func openDemo(t *testing.T) (*engine.Engine, protocol.DocumentInfoResult) {
	t.Helper()
	source, err := os.ReadFile("../../../../apps/editor-web/public/demo.wav")
	if err != nil {
		t.Fatal(err)
	}
	e := engine.New()
	var info protocol.DocumentInfoResult
	if _, err := Call(e, protocol.MethodDocumentOpen, protocol.DocumentOpenParams{Name: "demo.wav"}, source, &info); err != nil {
		t.Fatal(err)
	}
	return e, info
}

func TestSpeechStepInsertsSynthesizedAudio(t *testing.T) {
	e, info := openDemo(t)
	speaker := &fakeSpeaker{frames: speech.SampleRate / 10}
	chain := Chain{Version: 1, Operations: []Operation{
		{Method: protocol.MethodEditApply, Params: map[string]any{"operation": "crop", "start": 0, "end": 4800}},
		speechStep(map[string]any{"start": 4800, "end": 4800, "levelDb": -6}),
	}}
	result, err := ApplyChain(context.Background(), e, info.DocumentID, chain, speaker)
	if err != nil || result.Applied != 2 {
		t.Fatal("chain failed", result, err)
	}
	inserted := int64(speech.SampleRate/10) * int64(info.SampleRate) / speech.SampleRate
	if got := result.Results[1].Edit.Document.Frames; got != 4800+inserted {
		t.Fatalf("frames %d, want %d after inserting 0.1 s", got, 4800+inserted)
	}
	if len(speaker.requests) != 1 {
		t.Fatalf("speaker called %d times", len(speaker.requests))
	}
	got := speaker.requests[0]
	if got.Text != "Guten Tag." || got.Seed != 7 || got.LevelDB != -6 || got.Start != 4800 || got.End != 4800 || got.ChannelMask != (1<<info.Channels)-1 {
		t.Fatalf("speaker got %+v; want the step's parameters and the merged selection", got)
	}
	var history protocol.HistoryListResult
	if _, err := Call(e, protocol.MethodHistoryList, protocol.HistoryListParams{DocumentID: result.Results[1].Edit.Document.DocumentID}, nil, &history); err != nil {
		t.Fatal(err)
	}
	if len(history.Entries) != 3 {
		t.Fatalf("history has %d entries; want the original, the crop and one speech entry", len(history.Entries))
	}
}

func TestSpeechStepDryRunAndMissingSpeaker(t *testing.T) {
	e, info := openDemo(t)
	speaker := &fakeSpeaker{frames: 240}
	result, err := Apply(context.Background(), e, info.DocumentID, speechStep(map[string]any{"start": 0, "end": 0}), true, speaker)
	if err != nil || result.Candidate == nil || result.Edit != nil {
		t.Fatalf("dry run = %+v, %v; want a candidate and no edit", result, err)
	}
	var after protocol.DocumentInfoResult
	if _, err := Call(e, protocol.MethodDocumentInfo, nil, nil, &after); err != nil || after.Frames != info.Frames {
		t.Fatalf("dry run changed the document: %+v, %v", after, err)
	}
	_, err = Apply(context.Background(), e, info.DocumentID, speechStep(nil), false, nil)
	if !errors.Is(err, speech.ErrNoModelRoot) {
		t.Fatalf("Apply without a speaker = %v, want ErrNoModelRoot", err)
	}
}

func TestSpeechStepValidation(t *testing.T) {
	tests := []struct {
		name string
		op   Operation
		want string
	}{
		{"unknown model", speechStep(map[string]any{"model": "klingon"}), "unknown model"},
		{"empty text", speechStep(map[string]any{"text": ""}), "text is empty"},
		{"unknown field", speechStep(map[string]any{"pitch": 2}), "unknown field"},
		{"missing sampler steps", Operation{Method: protocol.ChainSpeechGenerate, Params: map[string]any{"model": "german", "voice": "juergen", "text": "Hallo."}}, "sampler steps"},
		{"audio generator without samples", Operation{Method: protocol.MethodProcessStart, Params: map[string]any{"operation": "generate", "generator": "audio", "sourceSampleRate": 24000}}, "speech.generate"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateOperation(tc.op)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("ValidateOperation = %v, want %q", err, tc.want)
			}
		})
	}
	if err := ValidateOperation(speechStep(nil)); err != nil {
		t.Fatal(err)
	}
}

func TestCLISpeechList(t *testing.T) {
	root := t.TempDir()
	m, err := pockettts.LookupModel("german")
	if err != nil {
		t.Fatal(err)
	}
	voice, _ := m.Voice(m.DefaultVoice)
	path := filepath.Join(root, filepath.FromSlash(voice.Path))
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, make([]byte, voice.Size), 0o600); err != nil {
		t.Fatal(err)
	}
	var stdout bytes.Buffer
	if err := RunCLI(context.Background(), []string{"speech", "list", "--speech-models", root}, &stdout, new(bytes.Buffer)); err != nil {
		t.Fatal(err)
	}
	catalog, _ := pockettts.LoadCatalog()
	lines := 0
	scanner := bufio.NewScanner(&stdout)
	for scanner.Scan() {
		var status SpeechModelStatus
		if err := json.Unmarshal(scanner.Bytes(), &status); err != nil {
			t.Fatal(err)
		}
		if status.Downloaded {
			t.Fatalf("%s reported downloaded without weights", status.Model)
		}
		if status.Model == "german" && (len(status.DownloadedVoices) != 1 || status.DownloadedVoices[0] != m.DefaultVoice) {
			t.Fatalf("german voices %v, want only %s", status.DownloadedVoices, m.DefaultVoice)
		}
		lines++
	}
	if lines != len(catalog.Models) {
		t.Fatalf("%d models listed, want %d", lines, len(catalog.Models))
	}
}

func TestCLISpeechUsageErrors(t *testing.T) {
	for _, args := range [][]string{
		{"speech"},
		{"speech", "bogus"},
		{"speech", "download", "--model", "german"},
		{"speech", "download", "--speech-models", t.TempDir()},
		{"speech", "download", "--speech-models", t.TempDir(), "--model", "klingon"},
		{"speech", "download", "--speech-models", t.TempDir(), "--model", "german", "--voice", "nobody"},
	} {
		if err := RunCLI(context.Background(), args, new(bytes.Buffer), new(bytes.Buffer)); err == nil {
			t.Fatalf("RunCLI(%v) = nil, want a usage error", args)
		}
	}
}
