//go:build !js

package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/automation"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/speech"
)

type speechArgs struct {
	rangeArgs
	Model        string   `json:"model" jsonschema:"catalog model, e.g. english_2026-01 or german; see list_speech_models"`
	Voice        string   `json:"voice,omitempty" jsonschema:"predefined voice of the model; default: its default voice"`
	Text         string   `json:"text" jsonschema:"text to speak, at most 5000 characters; long text is synthesized sentence by sentence"`
	Temperature  *float64 `json:"temperature,omitempty" jsonschema:"sampling temperature in [0, 2]; default: the model's"`
	SamplerSteps *int     `json:"samplerSteps,omitempty" jsonschema:"flow decode steps per frame in [1, 64]; default 1"`
	EOSThreshold *float64 `json:"eosThreshold,omitempty" jsonschema:"end-of-speech logit threshold; default -4"`
	Seed         uint64   `json:"seed,omitempty" jsonschema:"reproduces the speech on this build and platform"`
	LevelDB      float64  `json:"levelDb,omitempty" jsonschema:"gain in [-120, 0] dB"`
	DryRun       bool     `json:"dryRun,omitempty" jsonschema:"synthesize and evaluate the candidate without committing"`
}

func (s *Session) registerSpeechTools() {
	addTool(s, "generate_speech", "Speak text with go-pocket-tts (Kyutai PocketTTS, weights CC-BY-4.0) and place it like a generator: insert at the cursor or replace the range; the speech keeps its natural length. Undoable. Needs the server's --speech-models directory with the model downloaded (aae speech download).", false,
		func(ctx context.Context, input speechArgs) (any, error) {
			d, err := s.get(input.DocumentID)
			if err != nil {
				return nil, err
			}
			p, err := speech.Defaults(input.Model)
			if err != nil {
				return nil, err
			}
			p.Text, p.Seed, p.LevelDB = input.Text, input.Seed, input.LevelDB
			if input.Voice != "" {
				p.Voice = input.Voice
			}
			if input.Temperature != nil {
				p.Temperature = *input.Temperature
			}
			if input.SamplerSteps != nil {
				p.SamplerSteps = *input.SamplerSteps
			}
			if input.EOSThreshold != nil {
				p.EOSThreshold = *input.EOSThreshold
			}
			selection, err := s.selection(d, input.Range)
			if err != nil {
				return nil, err
			}
			p.SelectionRange = selection.SelectionRange
			params, err := operationParams(p)
			if err != nil {
				return nil, err
			}
			result, err := automation.Apply(ctx, d.kernel, d.info.DocumentID, automation.Operation{Method: protocol.ChainSpeechGenerate, Params: params}, input.DryRun, s.speaker)
			return operationResult(d, result), err
		})
	addTool(s, "list_speech_models", "List the speech models of the catalog with their voices, sizes and which are downloaded in the server's --speech-models directory.", true,
		func(_ context.Context, _ struct{}) (any, error) {
			models, err := automation.SpeechModels(s.speechRoot)
			if err != nil {
				return nil, err
			}
			return map[string]any{"modelDirectory": s.speechRoot, "models": models}, nil
		})
}

// operationParams turns parameters into a chain operation's params object,
// without the documentId the runner supplies.
func operationParams(p protocol.SpeechGenerateParams) (map[string]any, error) {
	data, err := json.Marshal(p)
	if err != nil {
		return nil, fmt.Errorf("generate_speech: encode: %w", err)
	}
	var params map[string]any
	if err := json.Unmarshal(data, &params); err != nil {
		return nil, fmt.Errorf("generate_speech: decode: %w", err)
	}
	delete(params, "documentId")
	return params, nil
}
