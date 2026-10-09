//go:build !js

package mcpserver

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/automation"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func TestGenerateSpeechNeedsAModelDirectory(t *testing.T) {
	directory := t.TempDir()
	path := writeFixture(t, directory)
	client, ctx := client(t, []string{directory})
	id := open(ctx, t, client, path)
	failure := call(ctx, t, client, "generate_speech", map[string]any{"documentId": id, "model": "german", "text": "Hallo."}, true)
	if !strings.Contains(failure["error"].(string), "--speech-models") {
		t.Fatalf("generate_speech without models = %v, want a --speech-models hint", failure)
	}
	failure = call(ctx, t, client, "generate_speech", map[string]any{"documentId": id, "model": "klingon", "text": "Hallo."}, true)
	if !strings.Contains(failure["error"].(string), "unknown model") {
		t.Fatalf("generate_speech(unknown model) = %v", failure)
	}
	models := call(ctx, t, client, "list_speech_models", map[string]any{}, false)
	if models["modelDirectory"] != "" || len(models["models"].([]any)) == 0 {
		t.Fatalf("list_speech_models = %v", models)
	}
}

// TestSpeechCLIAndMCPParity runs with AAE_SPEECH_MODELS pointing at a model
// root holding english_2026-01 and its alba voice: the CLI chain and the MCP
// tool must export identical bytes for one seed.
func TestSpeechCLIAndMCPParity(t *testing.T) {
	root := os.Getenv("AAE_SPEECH_MODELS")
	if root == "" {
		t.Skip("set AAE_SPEECH_MODELS to a speech model directory")
	}
	directory := t.TempDir()
	path := writeFixture(t, directory)
	client, ctx := speechClient(t, []string{directory}, root)
	id := open(ctx, t, client, path)
	result := call(ctx, t, client, "generate_speech", map[string]any{"documentId": id, "model": "english_2026-01", "voice": "alba", "text": "Parity.", "seed": 11, "range": map[string]any{"start": 0, "end": 0, "channelMask": 1}}, false)
	if result["changed"] != true {
		t.Fatalf("generate_speech = %v, want a committed edit", result)
	}
	mcpOutput := filepath.Join(directory, "mcp.wav")
	call(ctx, t, client, "export_document", map[string]any{"documentId": id, "path": mcpOutput, "format": "wav", "bitDepth": 32, "float": true}, false)

	chain := automation.Chain{Version: 1, Operations: []automation.Operation{{Method: protocol.ChainSpeechGenerate, Params: map[string]any{
		"model": "english_2026-01", "voice": "alba", "text": "Parity.", "temperature": 0.3, "samplerSteps": 1, "eosThreshold": -4, "seed": 11, "start": 0, "end": 0, "channelMask": 1,
	}}}}
	chainData, err := json.Marshal(chain)
	if err != nil {
		t.Fatal(err)
	}
	chainPath := filepath.Join(directory, "chain.json")
	if err := os.WriteFile(chainPath, chainData, 0o600); err != nil {
		t.Fatal(err)
	}
	cliOutput := filepath.Join(directory, "cli.wav")
	args := []string{"--input", path, "--output", cliOutput, "--chain", chainPath, "--allow-write", directory, "--bit-depth", "32", "--float", "--speech-models", root}
	if err := automation.RunCLI(ctx, args, new(bytes.Buffer), new(bytes.Buffer)); err != nil {
		t.Fatal(err)
	}
	a, errA := os.ReadFile(mcpOutput)
	b, errB := os.ReadFile(cliOutput)
	if errA != nil || errB != nil || !bytes.Equal(a, b) || len(a) <= len(fixtureWAV()) {
		t.Fatalf("MCP and CLI speech differ or are empty (%d vs %d bytes): %v %v", len(a), len(b), errA, errB)
	}
}
