//go:build !js

package automation

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/engine"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func TestWritePolicyTraversalSymlinkNoClobberAndAtomicOverwrite(t *testing.T) {
	parent := t.TempDir()
	allowed := filepath.Join(parent, "allowed")
	if err := os.Mkdir(allowed, 0o700); err != nil {
		t.Fatal(err)
	}
	policy, err := NewFilePolicy([]string{allowed})
	if err != nil {
		t.Fatal(err)
	}
	defer policy.Close()
	for _, path := range []string{filepath.Join(parent, "outside.wav"), filepath.Join(allowed, "..", "outside.wav"), allowed} {
		if _, err := policy.Write(path, []byte("bad"), false); err == nil {
			t.Fatal("escaped write policy", path)
		}
	}
	if runtime.GOOS != "windows" {
		if err := os.Symlink(parent, filepath.Join(allowed, "escape")); err != nil {
			t.Fatal(err)
		}
		if _, err := policy.Write(filepath.Join(allowed, "escape", "outside.wav"), []byte("bad"), true); err == nil {
			t.Fatal("symlink escaped allowed root")
		}
	}
	path := filepath.Join(allowed, "result.wav")
	if _, err := policy.Write(path, []byte("original"), false); err != nil {
		t.Fatal(err)
	}
	if _, err := policy.Write(path, []byte("unwanted"), false); err == nil {
		t.Fatal("overwrote without permission")
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "original" {
		t.Fatal("failed export damaged original", string(data), err)
	}
	if _, err := policy.Write(path, []byte("replacement"), true); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "replacement" {
		t.Fatal("explicit overwrite failed", err)
	}
	entries, err := os.ReadDir(allowed)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".aae-") {
			t.Fatal("staging file leaked", entry.Name())
		}
	}
	readonly, err := NewFilePolicy(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer readonly.Close()
	if _, err := readonly.Write(path, nil, true); err == nil {
		t.Fatal("empty allow list wrote")
	}
}

func TestReadLimitsAndStrictChainValidation(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "large")
	if err := os.WriteFile(path, []byte("12345"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadFile(path, 4); err == nil {
		t.Fatal("oversize input accepted")
	}
	if _, err := ReadFile(directory, 100); err == nil {
		t.Fatal("directory input accepted")
	}
	for _, input := range []string{
		`{"version":2,"operations":[]}`,
		`{"version":1,"operations":[],"typo":1}`,
		`{"version":1,"operations":[]} {}`,
		`{"version":1,"operations":[{"method":"tone.configure","params":{}}]}`,
		`{"version":1,"operations":[{"method":"process.start","params":{"operation":"gain","gain_dB":-6}}]}`,
		`{"version":1,"operations":[{"method":"process.start","params":{"documentId":"other","operation":"gain"}}]}`,
	} {
		if _, err := DecodeChain([]byte(input)); err == nil {
			t.Fatal("bad chain accepted", input)
		}
	}
	if _, err := DecodeChain([]byte(`{"version":1,"operations":[{"method":"process.start","params":{"operation":"gain","gainDb":-6}}]}`)); err != nil {
		t.Fatal(err)
	}
}

func TestCancellationDiscardsCandidateAndAllowsRetry(t *testing.T) {
	data, err := os.ReadFile("../../../../apps/editor-web/public/demo.wav")
	if err != nil {
		t.Fatal(err)
	}
	e := engine.New()
	var info protocol.DocumentInfoResult
	if _, err := Call(e, protocol.MethodDocumentOpen, protocol.DocumentOpenParams{Name: "demo.wav"}, data, &info); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	op := Operation{Method: protocol.MethodProcessStart, Params: map[string]any{"operation": "gain", "gainDb": -6}}
	if _, err := Apply(ctx, e, info.DocumentID, op, false); err == nil {
		t.Fatal("canceled operation succeeded")
	}
	var history protocol.HistoryListResult
	if _, err := Call(e, protocol.MethodHistoryList, protocol.HistoryListParams{DocumentID: info.DocumentID}, nil, &history); err != nil || history.Dirty {
		t.Fatal("cancellation changed history", history, err)
	}
	if _, err := Apply(context.Background(), e, info.DocumentID, op, true); err != nil {
		t.Fatal("retry dry-run failed", err)
	}
	if _, err := Apply(context.Background(), e, info.DocumentID, op, false); err != nil {
		t.Fatal("retry commit failed", err)
	}
}

func TestCLIRejectsUnauthorizedOutputBeforeReadingInput(t *testing.T) {
	err := RunCLI(context.Background(), []string{"--input", "missing.wav", "--output", filepath.Join(t.TempDir(), "result.wav")}, new(bytes.Buffer), new(bytes.Buffer))
	if err == nil || !strings.Contains(err.Error(), "allow-write") {
		t.Fatal("CLI did not reject unauthorized export first", err)
	}
}
