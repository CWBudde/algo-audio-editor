//go:build !js

package automation

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"path/filepath"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/engine"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

// WriteDirectories is a repeatable --allow-write flag shared by both fronts.
type WriteDirectories []string

func (d *WriteDirectories) String() string { return fmt.Sprint([]string(*d)) }
func (d *WriteDirectories) Set(value string) error {
	*d = append(*d, value)
	return nil
}

// RunCLI exposes a single-file chain runner. Batch UI and macro recording are
// independent later additions; output is emitted only after a successful chain.
func RunCLI(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("aae", flag.ContinueOnError)
	flags.SetOutput(stderr)
	input := flags.String("input", "", "input audio file (Go-supported WAV/FLAC/AIFF/MP3)")
	output := flags.String("output", "", "destination file; parent directory must exist")
	chainPath := flags.String("chain", "", "version 1 JSON operation chain; omit for conversion only")
	format := flags.String("format", "wav", "output format: wav, flac or aiff")
	depth := flags.Int("bit-depth", 16, "output bit depth")
	float := flags.Bool("float", false, "floating-point WAV/AIFF output")
	dither := flags.String("dither", "none", "dither: none or tpdf")
	overwrite := flags.Bool("overwrite", false, "explicitly replace an existing destination")
	var roots WriteDirectories
	flags.Var(&roots, "allow-write", "existing output directory (repeatable; writes disabled by default)")
	if err := flags.Parse(args); err != nil {
		return fmt.Errorf("aae: flags: %w", err)
	}
	if *input == "" || *output == "" || flags.NArg() != 0 {
		return fmt.Errorf("aae: --input and --output are required; run --help for usage")
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
	// Reject missing write authorization before doing expensive work.
	if _, _, _, err := policy.destination(*output); err != nil {
		return err
	}
	data, err := ReadFile(*input, MaxInputBytes)
	if err != nil {
		return err
	}
	e := engine.New()
	var info protocol.DocumentInfoResult
	if _, err := Call(e, protocol.MethodDocumentOpen, protocol.DocumentOpenParams{Name: filepath.Base(*input)}, data, &info); err != nil {
		return err
	}
	result, err := ApplyChain(ctx, e, info.DocumentID, chain)
	if err != nil {
		return err
	}
	if _, err := Call(e, protocol.MethodDocumentInfo, nil, nil, &info); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("aae: %w", err)
	}
	var exported protocol.DocumentExportInfo
	data, err = Call(e, protocol.MethodDocumentExport, protocol.DocumentExportParams{
		DocumentID: info.DocumentID, Format: *format, BitDepth: *depth, Float: *float, Dither: *dither,
	}, nil, &exported)
	if err != nil {
		return err
	}
	path, err := policy.Write(*output, data, *overwrite)
	if err != nil {
		return err
	}
	if err := json.NewEncoder(stdout).Encode(map[string]any{"path": path, "dataBytes": len(data), "applied": result.Applied}); err != nil {
		return fmt.Errorf("aae: write result: %w", err)
	}
	return nil
}
