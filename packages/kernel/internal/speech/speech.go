// Package speech adapts go-pocket-tts to the editor: it validates
// speech.generate parameters against the model catalog, maps them to
// synthesis options and, natively, synthesizes from a model root laid out
// by the download package. The browser's speech worker (cmd/speech) shares
// the validation and option mapping.
package speech

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"sync"
	"unicode/utf8"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
	pockettts "github.com/cwbudde/go-pocket-tts"
)

// SampleRate is the rate of all synthesized speech.
const SampleRate = pockettts.SampleRate

// Synthesis parameter bounds; pockettts enforces the same ones.
const (
	MaxTemperature  = 2.0
	MaxSamplerSteps = 64
)

// ErrNoModelRoot reports a native synthesis without --speech-models.
var ErrNoModelRoot = errors.New("speech: no model directory; pass --speech-models <dir> (fill it with `aae speech download`)")

// Validate checks p before any model is loaded: the model and voice exist in
// the catalog and every value is in range.
func Validate(p protocol.SpeechGenerateParams) error {
	m, err := pockettts.LookupModel(p.Model)
	if err != nil {
		return fmt.Errorf("speech: %w", err)
	}
	if _, ok := m.Voice(p.Voice); !ok {
		return fmt.Errorf("speech: model %s has no voice %q", p.Model, p.Voice)
	}
	switch n := utf8.RuneCountInString(p.Text); {
	case n == 0 || !hasLetterOrDigit(p.Text):
		return errors.New("speech: text is empty")
	case n > protocol.MaxSpeechTextRunes:
		return fmt.Errorf("speech: text has %d characters; the limit is %d", n, protocol.MaxSpeechTextRunes)
	}
	switch {
	case !finite(p.Temperature) || p.Temperature < 0 || p.Temperature > MaxTemperature:
		return fmt.Errorf("speech: temperature must be in [0, %g]", MaxTemperature)
	case p.SamplerSteps < 1 || p.SamplerSteps > MaxSamplerSteps:
		return fmt.Errorf("speech: sampler steps must be in [1, %d]", MaxSamplerSteps)
	case !finite(p.EOSThreshold):
		return errors.New("speech: EOS threshold must be finite")
	case !finite(p.LevelDB) || p.LevelDB < -120 || p.LevelDB > 0:
		return errors.New("speech: level must be in [-120, 0] dB")
	}
	return nil
}

// Options maps validated parameters to synthesis options.
func Options(p protocol.SpeechGenerateParams) pockettts.Options {
	return pockettts.Options{Temperature: p.Temperature, EOSThreshold: p.EOSThreshold, SamplerSteps: p.SamplerSteps, Seed: p.Seed}
}

// Defaults returns the parameters a new speech.generate step starts from.
func Defaults(model string) (protocol.SpeechGenerateParams, error) {
	m, err := pockettts.LookupModel(model)
	if err != nil {
		return protocol.SpeechGenerateParams{}, fmt.Errorf("speech: %w", err)
	}
	return protocol.SpeechGenerateParams{Model: m.Name, Voice: m.DefaultVoice, Text: m.DefaultText, Temperature: m.DefaultTemperature, SamplerSteps: 1, EOSThreshold: -4}, nil
}

func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

func hasLetterOrDigit(s string) bool {
	for _, r := range s {
		if r > ' ' {
			return true
		}
	}
	return false
}

// engine is the part of *pockettts.Engine the synthesizer uses; tests fake it.
type engine interface {
	Synthesize(ctx context.Context, text string, voice *pockettts.Voice, opts pockettts.Options) ([]float32, error)
	Close()
}

// Synthesizer synthesizes from the models below a model root. It keeps the
// last model loaded, so a chain of steps with one model loads it once.
type Synthesizer struct {
	root string

	mu     sync.Mutex
	model  string
	engine engine
	voices map[string]*pockettts.Voice

	loadEngine func(root, model string) (engine, error)
	loadVoice  func(root, model, voice string) (*pockettts.Voice, error)
}

// NewSynthesizer synthesizes from root; an empty root fails every call with
// ErrNoModelRoot.
func NewSynthesizer(root string) *Synthesizer {
	return &Synthesizer{
		root:       root,
		loadEngine: func(root, model string) (engine, error) { return pockettts.LoadDir(root, model) },
		loadVoice:  pockettts.LoadVoiceDir,
	}
}

// Synthesize speaks p and returns mono PCM at SampleRate.
func (s *Synthesizer) Synthesize(ctx context.Context, p protocol.SpeechGenerateParams) ([]float32, error) {
	if err := Validate(p); err != nil {
		return nil, err
	}
	if s.root == "" {
		return nil, ErrNoModelRoot
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.engine == nil || s.model != p.Model {
		s.closeLocked()
		e, err := s.loadEngine(s.root, p.Model)
		if err != nil {
			return nil, fmt.Errorf("speech: %w", err)
		}
		s.model, s.engine, s.voices = p.Model, e, map[string]*pockettts.Voice{}
	}
	voice, ok := s.voices[p.Voice]
	if !ok {
		var err error
		voice, err = s.loadVoice(s.root, p.Model, p.Voice)
		if err != nil {
			return nil, fmt.Errorf("speech: %w", err)
		}
		s.voices[p.Voice] = voice
	}
	pcm, err := s.engine.Synthesize(ctx, p.Text, voice, Options(p))
	if err != nil {
		return nil, fmt.Errorf("speech: %w", err)
	}
	return pcm, nil
}

// Close releases the loaded model.
func (s *Synthesizer) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closeLocked()
}

func (s *Synthesizer) closeLocked() {
	if s.engine != nil {
		s.engine.Close()
	}
	s.model, s.engine, s.voices = "", nil, nil
}

// EncodePCM returns samples as the little-endian float32 bytes the audio
// generator takes as process.start input.
func EncodePCM(samples []float32) []byte {
	out := make([]byte, 4*len(samples))
	for i, v := range samples {
		binary.LittleEndian.PutUint32(out[4*i:], math.Float32bits(v))
	}
	return out
}
