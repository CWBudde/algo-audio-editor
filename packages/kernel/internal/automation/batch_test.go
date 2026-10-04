//go:build !js

package automation

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/engine"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func writeFixture(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

// The CLI handles an actual hundred-file job. The oracle drives the UI's
// existing methods independently, without Apply or ApplyChain.
func TestCLIHundredFilesNormalizeFadeResampleFLAC(t *testing.T) {
	source, err := os.ReadFile("../../../../apps/editor-web/public/demo.wav")
	if err != nil {
		t.Fatal(err)
	}
	e := engine.New()
	var info protocol.DocumentInfoResult
	if _, err := Call(e, protocol.MethodDocumentOpen, protocol.DocumentOpenParams{Name: "demo.wav"}, source, &info); err != nil {
		t.Fatal(err)
	}
	frames := info.Frames
	requests := []map[string]any{
		{"operation": "normalize-loudness", "target": -16},
		{"operation": "fade-in", "start": 0, "end": 480, "curve": "linear"},
		{"operation": "fade-out", "start": frames - 480, "end": frames, "curve": "linear"},
		{"operation": "resample", "sampleRate": 44100, "quality": "balanced"},
	}
	chain := Chain{Version: 1}
	for _, request := range requests {
		params := make(map[string]any)
		for key, value := range request {
			params[key] = value
		}
		scope := ""
		if _, exists := request["start"]; !exists {
			scope = "document"
			params["start"] = int64(0)
			params["end"] = info.Frames
		}
		params["channelMask"] = (1 << info.Channels) - 1
		params["documentId"] = info.DocumentID
		var job protocol.ProcessJobResult
		if _, err := Call(e, protocol.MethodProcessStart, params, nil, &job); err != nil {
			t.Fatal(err)
		}
		jobParams := protocol.ProcessJobParams{DocumentID: info.DocumentID, JobID: job.JobID}
		for job.State == "running" {
			if _, err := Call(e, protocol.MethodProcessStepBatch, jobParams, nil, &job); err != nil {
				t.Fatal(err)
			}
		}
		var edit protocol.EditResult
		if _, err := Call(e, protocol.MethodProcessCommit, jobParams, nil, &edit); err != nil {
			t.Fatal(err)
		}
		info = edit.Document
		chain.Operations = append(chain.Operations, Operation{Method: protocol.MethodProcessStart, Params: request, Range: scope})
	}
	var export protocol.DocumentExportInfo
	expected, err := Call(e, protocol.MethodDocumentExport, protocol.DocumentExportParams{DocumentID: info.DocumentID, Format: "flac", BitDepth: 16}, nil, &export)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	chainData, err := json.Marshal(chain)
	if err != nil {
		t.Fatal(err)
	}
	chainPath := filepath.Join(root, "chain.json")
	writeFixture(t, chainPath, chainData)
	args := []string{"--output-dir", root, "--allow-write", root, "--format", "flac", "--chain", chainPath}
	for i := range 100 {
		input := filepath.Join(root, fmt.Sprintf("input-%03d.wav", i))
		writeFixture(t, input, source)
		args = append(args, "--input", input)
	}
	var stdout bytes.Buffer
	if err := RunCLI(context.Background(), args, &stdout, new(bytes.Buffer)); err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(&stdout)
	for i := range 100 {
		var result struct {
			Input     string
			Path      string
			Applied   int
			DataBytes int
			Error     string
		}
		if err := decoder.Decode(&result); err != nil {
			t.Fatal(err)
		}
		wantPath := filepath.Join(root, fmt.Sprintf("input-%03d-processed.flac", i))
		if result.Path != wantPath || result.Applied != 4 || result.DataBytes != len(expected) || result.Error != "" {
			t.Fatalf("file %d: %+v", i, result)
		}
		actual, err := os.ReadFile(wantPath)
		if err != nil || !bytes.Equal(actual, expected) {
			t.Fatalf("file %d differs from independent UI-method oracle: %v", i, err)
		}
	}
	if decoder.More() {
		t.Fatal("unexpected extra results")
	}
}

func TestBatchFailureIsolationNoClobberPreflightAndCancellation(t *testing.T) {
	source, err := os.ReadFile("../../../../apps/editor-web/public/demo.wav")
	if err != nil {
		t.Fatal(err)
	}
	for _, failFast := range []bool{false, true} {
		t.Run(fmt.Sprintf("fail-fast=%v", failFast), func(t *testing.T) {
			root := t.TempDir()
			bad, good := filepath.Join(root, "bad.wav"), filepath.Join(root, "good.wav")
			writeFixture(t, bad, []byte("not audio"))
			writeFixture(t, good, source)
			args := []string{"--input", bad, "--input", good, "--output-dir", root, "--allow-write", root}
			if failFast {
				args = append(args, "--fail-fast")
			}
			var stdout bytes.Buffer
			if err := RunCLI(context.Background(), args, &stdout, new(bytes.Buffer)); err == nil {
				t.Fatal("failed batch returned success")
			}
			_, err := os.Stat(filepath.Join(root, "good-processed.wav"))
			if failFast && !os.IsNotExist(err) || !failFast && err != nil {
				t.Fatal("failure policy", err)
			}
			if !strings.Contains(stdout.String(), `"error"`) {
				t.Fatal("missing per-file failure", stdout.String())
			}
			if _, err := os.Stat(filepath.Join(root, "bad-processed.wav")); !os.IsNotExist(err) {
				t.Fatal("failed file produced output")
			}
			if !failFast {
				original, err := os.ReadFile(filepath.Join(root, "good-processed.wav"))
				if err != nil {
					t.Fatal(err)
				}
				if err := RunCLI(context.Background(), args, new(bytes.Buffer), new(bytes.Buffer)); err == nil {
					t.Fatal("existing output overwritten")
				}
				after, err := os.ReadFile(filepath.Join(root, "good-processed.wav"))
				if err != nil || !bytes.Equal(original, after) {
					t.Fatal("existing output damaged")
				}
			}
		})
	}
	root := t.TempDir()
	input := filepath.Join(root, "missing.wav")
	duplicate := []string{"--input", input, "--input", input, "--output-dir", root, "--allow-write", root}
	if err := RunCLI(context.Background(), duplicate, new(bytes.Buffer), new(bytes.Buffer)); err == nil || !strings.Contains(err.Error(), "duplicate output") {
		t.Fatal("duplicate destination not preflighted", err)
	}
	unauthorized := []string{"--input", input, "--output-dir", root}
	if err := RunCLI(context.Background(), unauthorized, new(bytes.Buffer), new(bytes.Buffer)); err == nil || !strings.Contains(err.Error(), "allow-write") {
		t.Fatal("unauthorized batch read inputs", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	canceled := []string{"--input", input, "--output-dir", root, "--allow-write", root}
	if err := RunCLI(ctx, canceled, new(bytes.Buffer), new(bytes.Buffer)); err == nil || !strings.Contains(err.Error(), "canceled") {
		t.Fatal("canceled batch read input", err)
	}
}

func TestDocumentRangeTracksStructuralChangesAndClipboard(t *testing.T) {
	source, err := os.ReadFile("../../../../apps/editor-web/public/demo.wav")
	if err != nil {
		t.Fatal(err)
	}
	e := engine.New()
	var info protocol.DocumentInfoResult
	if _, err := Call(e, protocol.MethodDocumentOpen, protocol.DocumentOpenParams{Name: "demo.wav"}, source, &info); err != nil {
		t.Fatal(err)
	}
	chain := Chain{Version: 1, Operations: []Operation{
		{Method: protocol.MethodEditApply, Params: map[string]any{"operation": "crop", "start": 0, "end": 4800}},
		{Method: protocol.MethodEditApply, Range: "document", Params: map[string]any{"operation": "copy"}},
		{Method: protocol.MethodEditApply, Params: map[string]any{"operation": "paste-insert", "start": 4800, "end": 4800, "convert": true}},
		{Method: protocol.MethodProcessStart, Range: "document", Params: map[string]any{"operation": "reverse"}},
	}}
	result, err := ApplyChain(context.Background(), e, info.DocumentID, chain)
	if err != nil || result.Applied != 4 {
		t.Fatal("chain failed", result, err)
	}
	if result.Results[3].Edit.Document.Frames != 9600 || result.Results[3].Candidate.End != 9600 {
		t.Fatal("document range did not follow growth", result.Results[3])
	}
	for _, op := range []Operation{
		{Method: protocol.MethodEditApply, Range: "unknown", Params: map[string]any{"operation": "copy"}},
		{Method: protocol.MethodEditApply, Range: "document", Params: map[string]any{"operation": "copy", "start": 0}},
	} {
		if err := ValidateOperation(op); err == nil {
			t.Fatal("invalid document range accepted", op)
		}
	}
}
