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

// Roots and destinations are canonicalized alike, so a root or destination
// spelled through a directory symlink (macOS /tmp -> /private/tmp) is accepted,
// while links that leave the root are still rejected.
func TestWritePolicyCanonicalizesSymlinkedRootsAndDestinations(t *testing.T) {
	base := t.TempDir()
	actual := filepath.Join(base, "real")
	outside := filepath.Join(base, "outside")
	for _, directory := range []string{actual, filepath.Join(actual, "sub"), outside} {
		if err := os.Mkdir(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	target := filepath.Join(outside, "target.wav")
	writeFixture(t, target, []byte("outside"))
	link := filepath.Join(base, "link")
	if err := os.Symlink(actual, link); err != nil {
		if runtime.GOOS == "windows" {
			t.Skip("creating symlinks requires Developer Mode or elevation:", err)
		}
		t.Fatal(err)
	}
	for _, symlink := range []struct{ name, target string }{
		{"escape", outside},
		{"dangling", filepath.Join(base, "missing")},
		{"leaf.wav", target},
	} {
		if err := os.Symlink(symlink.target, filepath.Join(actual, symlink.name)); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		name, root, path, written string
		overwrite, wantErr        bool
	}{
		{name: "symlinked root, new file", root: link, path: filepath.Join(link, "new.wav"), written: filepath.Join(actual, "new.wav")},
		{name: "symlinked root, subdirectory", root: link, path: filepath.Join(link, "sub", "new.wav"), written: filepath.Join(actual, "sub", "new.wav")},
		{name: "symlinked root, actual destination", root: link, path: filepath.Join(actual, "direct.wav"), written: filepath.Join(actual, "direct.wav")},
		{name: "actual root, symlinked destination", root: actual, path: filepath.Join(link, "via-link.wav"), written: filepath.Join(actual, "via-link.wav")},
		{name: "actual root, symlinked subdirectory", root: actual, path: filepath.Join(link, "sub", "via-link.wav"), written: filepath.Join(actual, "sub", "via-link.wav")},
		{name: "leaf symlink is replaced, not followed", root: link, path: filepath.Join(link, "leaf.wav"), written: filepath.Join(actual, "leaf.wav"), overwrite: true},
		{name: "symlink escape", root: link, path: filepath.Join(link, "escape", "x.wav"), wantErr: true},
		{name: "symlink escape from actual root", root: actual, path: filepath.Join(link, "escape", "x.wav"), wantErr: true},
		{name: "dangling symlink escape", root: link, path: filepath.Join(link, "dangling", "x.wav"), wantErr: true},
		{name: "dot-dot escape", root: link, path: filepath.Join(link, "..", "outside", "x.wav"), wantErr: true},
		{name: "root itself via symlink", root: actual, path: link + string(filepath.Separator), wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			policy, err := NewFilePolicy([]string{tc.root})
			if err != nil {
				t.Fatal(err)
			}
			defer policy.Close()
			reported, err := policy.Write(tc.path, []byte("written"), tc.overwrite)
			if tc.wantErr {
				if err == nil {
					t.Fatal("write escaped allowed root", tc.path)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if absolute, _ := filepath.Abs(tc.path); reported != absolute {
				t.Fatalf("reported %q, want caller spelling %q", reported, absolute)
			}
			info, err := os.Lstat(tc.written)
			if err != nil || !info.Mode().IsRegular() {
				t.Fatal("destination is not a regular file", info, err)
			}
			if data, err := os.ReadFile(tc.written); err != nil || string(data) != "written" {
				t.Fatal("unexpected destination content", string(data), err)
			}
		})
	}
	if data, err := os.ReadFile(target); err != nil || string(data) != "outside" {
		t.Fatal("write followed a symlink out of the root", string(data), err)
	}
	for _, path := range []string{filepath.Join(outside, "x.wav"), filepath.Join(base, "missing")} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatal("escaped write created", path, err)
		}
	}
}
