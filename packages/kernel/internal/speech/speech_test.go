package speech

import (
	"context"
	"encoding/binary"
	"errors"
	"math"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
	pockettts "github.com/cwbudde/go-pocket-tts"
)

func validParams() protocol.SpeechGenerateParams {
	p, err := Defaults("german")
	if err != nil {
		panic(err)
	}
	p.Text = "Guten Tag."
	return p
}

func TestValidate(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*protocol.SpeechGenerateParams)
		want   string
	}{
		{"valid", func(*protocol.SpeechGenerateParams) {}, ""},
		{"unknown model", func(p *protocol.SpeechGenerateParams) { p.Model = "klingon" }, "unknown model"},
		{"unknown voice", func(p *protocol.SpeechGenerateParams) { p.Voice = "nobody" }, "no voice"},
		{"empty text", func(p *protocol.SpeechGenerateParams) { p.Text = "" }, "text is empty"},
		{"blank text", func(p *protocol.SpeechGenerateParams) { p.Text = " \n\t" }, "text is empty"},
		{"punctuation only", func(p *protocol.SpeechGenerateParams) { p.Text = "!!! …" }, "text is empty"},
		{"digits only", func(p *protocol.SpeechGenerateParams) { p.Text = "42" }, ""},
		{"non-Latin letters", func(p *protocol.SpeechGenerateParams) { p.Text = "Grüße, 東京" }, ""},
		{"text at the limit", func(p *protocol.SpeechGenerateParams) { p.Text = strings.Repeat("ä", protocol.MaxSpeechTextRunes) }, ""},
		{"text over the limit", func(p *protocol.SpeechGenerateParams) { p.Text = strings.Repeat("ä", protocol.MaxSpeechTextRunes+1) }, "limit is 5000"},
		{"negative temperature", func(p *protocol.SpeechGenerateParams) { p.Temperature = -0.1 }, "temperature"},
		{"NaN temperature", func(p *protocol.SpeechGenerateParams) { p.Temperature = math.NaN() }, "temperature"},
		{"zero sampler steps", func(p *protocol.SpeechGenerateParams) { p.SamplerSteps = 0 }, "sampler steps"},
		{"infinite EOS threshold", func(p *protocol.SpeechGenerateParams) { p.EOSThreshold = math.Inf(-1) }, "EOS"},
		{"positive level", func(p *protocol.SpeechGenerateParams) { p.LevelDB = 1 }, "level"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := validParams()
			tc.mutate(&p)
			err := Validate(p)
			if tc.want == "" && err != nil || tc.want != "" && (err == nil || !strings.Contains(err.Error(), tc.want)) {
				t.Fatalf("Validate = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestDefaultsFollowTheCatalog(t *testing.T) {
	p, err := Defaults("german")
	if err != nil {
		t.Fatal(err)
	}
	m, _ := pockettts.LookupModel("german")
	if p.Voice != m.DefaultVoice || p.Temperature != m.DefaultTemperature || p.Text != m.DefaultText || p.SamplerSteps != 1 {
		t.Fatalf("defaults %+v do not follow the catalog %+v", p, m)
	}
	if _, err := Defaults("klingon"); err == nil {
		t.Fatal("Defaults(unknown) = nil")
	}
}

type fakeEngine struct {
	name   string
	closed *[]string
	calls  *[]pockettts.Options
}

func (f fakeEngine) Synthesize(_ context.Context, text string, _ *pockettts.Voice, opts pockettts.Options) ([]float32, error) {
	*f.calls = append(*f.calls, opts)
	if text == "fail" {
		return nil, errors.New("boom")
	}
	return []float32{float32(len(text))}, nil
}

func (f fakeEngine) Close() { *f.closed = append(*f.closed, f.name) }

func TestSynthesizerCachesTheModelAndVoices(t *testing.T) {
	var loads, voiceLoads, closed []string
	var calls []pockettts.Options
	s := NewSynthesizer("models")
	s.loadEngine = func(root, model string) (engine, error) {
		loads = append(loads, root+"/"+model)
		return fakeEngine{name: model, closed: &closed, calls: &calls}, nil
	}
	s.loadVoice = func(_, model, voice string) (*pockettts.Voice, error) {
		voiceLoads = append(voiceLoads, model+"/"+voice)
		return &pockettts.Voice{}, nil
	}
	german := validParams()
	german.Seed = 9
	for range 2 {
		pcm, err := s.Synthesize(context.Background(), german)
		if err != nil || !reflect.DeepEqual(pcm, []float32{10}) {
			t.Fatalf("Synthesize = %v, %v", pcm, err)
		}
	}
	english, _ := Defaults("english_2026-01")
	if _, err := s.Synthesize(context.Background(), english); err != nil {
		t.Fatal(err)
	}
	s.Close()
	if !reflect.DeepEqual(loads, []string{"models/german", "models/english_2026-01"}) {
		t.Fatalf("engine loads %v; want one per model", loads)
	}
	if !reflect.DeepEqual(voiceLoads, []string{"german/juergen", "english_2026-01/alba"}) {
		t.Fatalf("voice loads %v; want one per voice", voiceLoads)
	}
	if !reflect.DeepEqual(closed, []string{"german", "english_2026-01"}) {
		t.Fatalf("closed %v; switching and Close must release each model", closed)
	}
	if got := calls[0]; got.Temperature != german.Temperature || got.EOSThreshold != -4 || got.SamplerSteps != 1 || got.Seed != 9 {
		t.Fatalf("options %+v do not follow the parameters", calls[0])
	}
}

func TestSynthesizerErrors(t *testing.T) {
	if _, err := NewSynthesizer("").Synthesize(context.Background(), validParams()); !errors.Is(err, ErrNoModelRoot) {
		t.Fatalf("no model root = %v, want ErrNoModelRoot", err)
	}
	invalid := validParams()
	invalid.Text = ""
	if _, err := NewSynthesizer("").Synthesize(context.Background(), invalid); err == nil || errors.Is(err, ErrNoModelRoot) {
		t.Fatalf("invalid parameters = %v, want a validation error first", err)
	}
	s := NewSynthesizer(t.TempDir())
	if _, err := s.Synthesize(context.Background(), validParams()); err == nil || !strings.Contains(err.Error(), "download the model first") {
		t.Fatalf("missing model = %v, want a download hint", err)
	}
	var closed []string
	var calls []pockettts.Options
	s.loadEngine = func(_, model string) (engine, error) {
		return fakeEngine{name: model, closed: &closed, calls: &calls}, nil
	}
	s.loadVoice = func(_, _, _ string) (*pockettts.Voice, error) { return &pockettts.Voice{}, nil }
	failing := validParams()
	failing.Text = "fail"
	if _, err := s.Synthesize(context.Background(), failing); err == nil || !strings.HasPrefix(err.Error(), "speech: ") {
		t.Fatalf("synthesis failure = %v, want a speech: error", err)
	}
}

func TestEncodePCM(t *testing.T) {
	samples := []float32{0, -1, 0.5, float32(math.SmallestNonzeroFloat32)}
	data := EncodePCM(samples)
	for i, v := range samples {
		if got := math.Float32frombits(binary.LittleEndian.Uint32(data[4*i:])); got != v {
			t.Fatalf("sample %d = %v, want %v", i, got, v)
		}
	}
}

// TestRealModelSynthesis runs with AAE_SPEECH_MODELS pointing at a model
// root that holds english_2026-01 (aae speech download --model english_2026-01).
func TestRealModelSynthesis(t *testing.T) {
	root := os.Getenv("AAE_SPEECH_MODELS")
	if root == "" {
		t.Skip("set AAE_SPEECH_MODELS to a speech model directory")
	}
	s := NewSynthesizer(root)
	defer s.Close()
	p, err := Defaults("english_2026-01")
	if err != nil {
		t.Fatal(err)
	}
	p.Text, p.Seed = "Hello from the editor.", 3
	a, err := s.Synthesize(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.Synthesize(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	if len(a) < SampleRate/2 || !reflect.DeepEqual(a, b) {
		t.Fatalf("got %d and %d samples; want at least half a second, identical for one seed", len(a), len(b))
	}
}
