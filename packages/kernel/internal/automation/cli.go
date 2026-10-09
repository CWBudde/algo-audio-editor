//go:build !js

package automation

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/engine"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/speech"
)

// WriteDirectories is a repeatable --allow-write flag shared by both fronts.
type WriteDirectories []string

func (d *WriteDirectories) String() string { return fmt.Sprint([]string(*d)) }

// Set appends a repeatable allowed-write directory flag.
func (d *WriteDirectories) Set(value string) error {
	*d = append(*d, value)
	return nil
}

// RunCLI processes files sequentially with isolated engines and JSON results.
// A failed file never publishes output; successful earlier files remain on disk.
// `aae speech …` lists and downloads speech models instead.
func RunCLI(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	if len(args) > 0 && args[0] == "speech" {
		return runSpeechCLI(ctx, args[1:], stdout, stderr)
	}
	flags := flag.NewFlagSet("aae", flag.ContinueOnError)
	flags.SetOutput(stderr)
	var inputs WriteDirectories
	flags.Var(&inputs, "input", "input audio file (repeatable; Go-supported WAV/FLAC/AIFF/MP3)")
	outputDir := flags.String("output-dir", "", "batch destination directory; must already exist")
	suffix := flags.String("suffix", "-processed", "batch filename suffix before the format extension")
	failFast := flags.Bool("fail-fast", false, "stop the batch after its first failed file")
	output := flags.String("output", "", "destination file; parent directory must exist")
	chainPath := flags.String("chain", "", "version 1 JSON operation chain; omit for conversion only")
	format := flags.String("format", "wav", "output format: wav, flac or aiff")
	depth := flags.Int("bit-depth", 16, "output bit depth")
	float := flags.Bool("float", false, "floating-point WAV/AIFF output")
	dither := flags.String("dither", "none", "dither: none, rectangular, triangular, gaussian or fast-gaussian")
	overwrite := flags.Bool("overwrite", false, "explicitly replace an existing destination")
	var roots WriteDirectories
	flags.Var(&roots, "allow-write", "existing output directory (repeatable; writes disabled by default)")
	speechModels := flags.String("speech-models", "", "speech model directory for speech.generate steps (fill it with `aae speech download`)")
	if err := flags.Parse(args); err != nil {
		return fmt.Errorf("aae: flags: %w", err)
	}
	if len(inputs) == 0 || flags.NArg() != 0 || (*output == "" && *outputDir == "") || (*output != "" && (*outputDir != "" || len(inputs) != 1)) {
		return fmt.Errorf("aae: use --input with --output for one file, or repeat --input with --output-dir; run --help for usage")
	}
	if *format != "wav" && *format != "flac" && *format != "aiff" {
		return fmt.Errorf("aae: format must be wav, flac or aiff")
	}
	if strings.ContainsAny(*suffix, `/\`) {
		return fmt.Errorf("aae: suffix must not contain path separators")
	}
	chain := Chain{Version: 1}
	if *chainPath != "" {
		data, err := ReadFile(*chainPath, 1<<20)
		if err != nil {
			return err
		}
		chain, err = DecodeChain(data)
		if err != nil {
			return err
		}
	}
	policy, err := NewFilePolicy(roots)
	if err != nil {
		return err
	}
	defer policy.Close()
	// Preflight every destination before reading audio or publishing any file.
	outputs := make([]string, len(inputs))
	seen := make(map[string]bool, len(inputs))
	for i, input := range inputs {
		outputs[i] = *output
		if *outputDir != "" {
			base := filepath.Base(input)
			base = strings.TrimSuffix(base, filepath.Ext(base))
			outputs[i] = filepath.Join(*outputDir, base+*suffix+"."+*format)
		}
		_, _, absolute, canonical, err := policy.destination(outputs[i])
		if err != nil {
			return err
		}
		if runtime.GOOS == "windows" {
			canonical = strings.ToLower(canonical)
		}
		if seen[canonical] {
			return fmt.Errorf("aae: duplicate output path %q; rename inputs or choose separate batches", absolute)
		}
		seen[canonical] = true
	}
	params := protocol.DocumentExportParams{Format: *format, BitDepth: *depth, Float: *float, Dither: *dither}
	// One synthesizer for the batch loads each speech model once.
	speaker := speech.NewSynthesizer(*speechModels)
	defer speaker.Close()
	failed := 0
	encoder := json.NewEncoder(stdout)
	for i, input := range inputs {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("aae: %w", err)
		}
		result, err := convertFile(ctx, policy, input, outputs[i], chain, params, *overwrite, speaker)
		if err != nil {
			if *outputDir == "" {
				return err
			}
			failed++
			result = map[string]any{"input": input, "path": outputs[i], "error": err.Error()}
		}
		if encodeErr := encoder.Encode(result); encodeErr != nil {
			return fmt.Errorf("aae: write result: %w", encodeErr)
		}
		if err != nil && *failFast {
			return fmt.Errorf("aae: batch stopped after %d file(s): %w", i+1, err)
		}
	}
	if failed != 0 {
		return fmt.Errorf("aae: %d of %d files failed; inspect JSON results", failed, len(inputs))
	}
	return nil
}

func convertFile(ctx context.Context, policy *FilePolicy, input, output string, chain Chain, params protocol.DocumentExportParams, overwrite bool, speaker Speaker) (map[string]any, error) {
	data, err := ReadFile(input, MaxInputBytes)
	if err != nil {
		return nil, err
	}
	e := engine.New()
	var info protocol.DocumentInfoResult
	if _, err := Call(e, protocol.MethodDocumentOpen, protocol.DocumentOpenParams{Name: filepath.Base(input)}, data, &info); err != nil {
		return nil, err
	}
	result, err := ApplyChain(ctx, e, info.DocumentID, chain, speaker)
	if err != nil {
		return nil, err
	}
	if _, err := Call(e, protocol.MethodDocumentInfo, nil, nil, &info); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("aae: %w", err)
	}
	params.DocumentID = info.DocumentID
	var exported protocol.DocumentExportInfo
	data, err = Call(e, protocol.MethodDocumentExport, params, nil, &exported)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("aae: %w", err)
	}
	path, err := policy.Write(output, data, overwrite)
	if err != nil {
		return nil, err
	}
	return map[string]any{"input": input, "path": path, "dataBytes": len(data), "applied": result.Applied}, nil
}
