package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	pockettts "github.com/cwbudde/go-pocket-tts"
)

const params = `{"model":"english_2026-01","voice":"alba","text":"Hello there. This is the speech worker.","temperature":0.3,"samplerSteps":1,"eosThreshold":-4,"seed":5}`

func TestBridgeRejectsBeforeLoading(t *testing.T) {
	var b bridge
	tests := []struct {
		name, params, want string
	}{
		{"not loaded", params, "is not loaded"},
		{"unknown field", strings.Replace(params, `"seed"`, `"pitch"`, 1), "unknown field"},
		{"trailing data", params + "{}", "exactly one"},
		{"invalid text", strings.Replace(params, `"Hello there. This is the speech worker."`, `""`, 1), "text is empty"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := b.synthesize([]byte(tc.params), nil)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("synthesize = %v, want %q", err, tc.want)
			}
		})
	}
	if err := b.loadVoice("english_2026-01", "alba", nil); err == nil {
		t.Fatal("loadVoice accepted an empty voice")
	}
	if err := b.loadVoice("english_2026-01", "nobody", nil); err == nil || !strings.Contains(err.Error(), "no voice") {
		t.Fatalf("loadVoice(unknown) = %v", err)
	}
	if err := b.load("klingon", nil, nil); err == nil {
		t.Fatal("load accepted an unknown model")
	}
	if err := b.unload(); err != nil {
		t.Fatal(err)
	}
}

// loadedBridge loads english_2026-01 and alba from AAE_SPEECH_MODELS, the way
// the worker hands over fetched bytes.
func loadedBridge(t *testing.T) *bridge {
	t.Helper()
	root := os.Getenv("AAE_SPEECH_MODELS")
	if root == "" {
		t.Skip("set AAE_SPEECH_MODELS to a speech model directory")
	}
	m, err := pockettts.LookupModel("english_2026-01")
	if err != nil {
		t.Fatal(err)
	}
	alba, _ := m.Voice("alba")
	read := func(f pockettts.File) []byte {
		data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(f.Path)))
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	b := new(bridge)
	if err := b.load(m.Name, read(m.Weights), read(m.Tokenizer)); err != nil {
		t.Fatal(err)
	}
	if err := b.loadVoice(m.Name, "alba", read(alba.File)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = b.unload() })
	return b
}

func TestBridgeSynthesizesAndCancels(t *testing.T) {
	b := loadedBridge(t)
	pcm, err := b.synthesize([]byte(params), nil)
	if err != nil || len(pcm) == 0 || len(pcm)%4 != 0 {
		t.Fatalf("synthesize = %d bytes, %v", len(pcm), err)
	}
	if model, voices := b.loaded(); model != "english_2026-01" || len(voices) != 1 {
		t.Fatalf("loaded = %s %v", model, voices)
	}

	var once sync.Once
	var concurrent error
	_, err = b.synthesize([]byte(params), func(pockettts.Progress) {
		once.Do(func() {
			_, concurrent = b.synthesize([]byte(params), nil)
			if err := b.unload(); !errors.Is(err, errBusy) {
				t.Errorf("unload during synthesis = %v, want errBusy", err)
			}
			b.stop()
		})
	})
	if err == nil || !strings.Contains(err.Error(), "canceled") {
		t.Fatalf("cancelled synthesis = %v, want a cancellation", err)
	}
	if !errors.Is(concurrent, errBusy) {
		t.Fatalf("concurrent synthesis = %v, want errBusy", concurrent)
	}
	if _, err := b.synthesize([]byte(params), nil); err != nil {
		t.Fatalf("synthesis after a cancel = %v", err)
	}
}
