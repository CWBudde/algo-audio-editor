// Command speech is the speech worker's WebAssembly entry point. It holds
// one go-pocket-tts model, loaded from bytes the worker fetched, and turns
// speech.generate parameters into mono float32 PCM for the kernel's audio
// generator. It never touches documents. The platform-independent part lives
// here so it is testable natively; main_js.go is the syscall/js glue.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/speech"
	pockettts "github.com/cwbudde/go-pocket-tts"
)

// errBusy reports a second synthesis while one runs; the worker serializes.
var errBusy = errors.New("speech: a synthesis is already running")

// bridge owns the loaded model and the running synthesis.
type bridge struct {
	mu     sync.Mutex
	model  string
	engine *pockettts.Engine
	voices map[string]*pockettts.Voice
	cancel context.CancelFunc
}

// load replaces the loaded model. The old one is released first, so two
// models never share the 4 GiB address space.
func (b *bridge) load(model string, weights, tokenizer []byte) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.cancel != nil {
		return errBusy
	}
	b.unloadLocked()
	e, err := pockettts.Load(model, weights, tokenizer)
	if err != nil {
		return fmt.Errorf("speech: %w", err)
	}
	b.model, b.engine, b.voices = model, e, map[string]*pockettts.Voice{}
	return nil
}

// loadVoice parses a predefined voice of the loaded model.
func (b *bridge) loadVoice(model, voice string, data []byte) error {
	m, err := pockettts.LookupModel(model)
	if err != nil {
		return fmt.Errorf("speech: %w", err)
	}
	if _, ok := m.Voice(voice); !ok {
		return fmt.Errorf("speech: model %s has no voice %q", model, voice)
	}
	parsed, err := pockettts.ParseVoice(data)
	if err != nil {
		return fmt.Errorf("speech: voice %s: %w", voice, err)
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.engine == nil || b.model != model {
		return fmt.Errorf("speech: load model %s before its voices", model)
	}
	b.voices[voice] = parsed
	return nil
}

// loaded reports the model and the voices ready for synthesis.
func (b *bridge) loaded() (string, []string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	voices := make([]string, 0, len(b.voices))
	for id := range b.voices {
		voices = append(voices, id)
	}
	return b.model, voices
}

// synthesize speaks the speech.generate parameters in paramsJSON (selection
// fields are ignored) and returns little-endian float32 PCM at
// speech.SampleRate. progress runs after every generated frame; the JS glue
// yields to the event loop there, so cancel can arrive.
func (b *bridge) synthesize(paramsJSON []byte, progress func(pockettts.Progress)) ([]byte, error) {
	var p protocol.SpeechGenerateParams
	d := json.NewDecoder(bytes.NewReader(paramsJSON))
	d.DisallowUnknownFields()
	if err := d.Decode(&p); err != nil {
		return nil, fmt.Errorf("speech: parameters: %w", err)
	}
	if err := d.Decode(new(any)); !errors.Is(err, io.EOF) {
		return nil, errors.New("speech: parameters: expected exactly one JSON object")
	}
	if err := speech.Validate(p); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	b.mu.Lock()
	switch {
	case b.cancel != nil:
		b.mu.Unlock()
		return nil, errBusy
	case b.engine == nil || b.model != p.Model:
		b.mu.Unlock()
		return nil, fmt.Errorf("speech: model %s is not loaded", p.Model)
	}
	voice, ok := b.voices[p.Voice]
	if !ok {
		b.mu.Unlock()
		return nil, fmt.Errorf("speech: voice %s is not loaded", p.Voice)
	}
	engine := b.engine
	b.cancel = cancel
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		b.cancel = nil
		b.mu.Unlock()
	}()
	opts := speech.Options(p)
	opts.Progress = progress
	pcm, err := engine.Synthesize(ctx, p.Text, voice, opts)
	if err != nil {
		return nil, fmt.Errorf("speech: %w", err)
	}
	return speech.EncodePCM(pcm), nil
}

// stop cancels the running synthesis, if any.
func (b *bridge) stop() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.cancel != nil {
		b.cancel()
	}
}

// unload releases the model unless a synthesis still uses it.
func (b *bridge) unload() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.cancel != nil {
		return errBusy
	}
	b.unloadLocked()
	return nil
}

func (b *bridge) unloadLocked() {
	if b.engine != nil {
		b.engine.Close()
	}
	b.model, b.engine, b.voices = "", nil, nil
}
