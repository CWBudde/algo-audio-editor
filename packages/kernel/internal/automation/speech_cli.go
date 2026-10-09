//go:build !js

package automation

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"

	pockettts "github.com/cwbudde/go-pocket-tts"
	"github.com/cwbudde/go-pocket-tts/download"
)

// SpeechModelStatus describes a catalog model and whether its files are
// present below a model directory.
type SpeechModelStatus struct {
	Model      string   `json:"model"`
	Label      string   `json:"label"`
	Language   string   `json:"language"`
	Layers     int      `json:"layers"`
	Bytes      int64    `json:"bytes"`
	Downloaded bool     `json:"downloaded"`
	Voices     []string `json:"voices"`
	// DownloadedVoices lists the voices present below the directory.
	DownloadedVoices []string `json:"downloadedVoices"`
}

// SpeechModels lists the catalog with the files present below root (none
// when root is empty). Presence is checked by size; loading verifies more.
func SpeechModels(root string) ([]SpeechModelStatus, error) {
	catalog, err := pockettts.LoadCatalog()
	if err != nil {
		return nil, err
	}
	out := make([]SpeechModelStatus, 0, len(catalog.Models))
	for _, m := range catalog.Models {
		status := SpeechModelStatus{
			Model: m.Name, Label: m.Label, Language: m.Language, Layers: m.Layers,
			Bytes:      m.Weights.Size + m.Tokenizer.Size,
			Downloaded: present(root, m.Weights) && present(root, m.Tokenizer),
			Voices:     make([]string, 0, len(m.Voices)), DownloadedVoices: []string{},
		}
		for _, v := range m.Voices {
			status.Voices = append(status.Voices, v.ID)
			if present(root, v.File) {
				status.DownloadedVoices = append(status.DownloadedVoices, v.ID)
			}
		}
		out = append(out, status)
	}
	return out, nil
}

func present(root string, f pockettts.File) bool {
	if root == "" {
		return false
	}
	info, err := os.Stat(filepath.Join(root, filepath.FromSlash(f.Path)))
	return err == nil && info.Mode().IsRegular() && info.Size() == f.Size
}

// runSpeechCLI implements `aae speech list` and `aae speech download`.
func runSpeechCLI(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 || (args[0] != "list" && args[0] != "download") {
		return fmt.Errorf("aae speech: use `aae speech list --speech-models <dir>` or `aae speech download --speech-models <dir> --model <name> [--voice <id>]...`")
	}
	command := args[0]
	flags := flag.NewFlagSet("aae speech "+command, flag.ContinueOnError)
	flags.SetOutput(stderr)
	root := flags.String("speech-models", "", "speech model directory (catalog layout)")
	model := flags.String("model", "", "catalog model to download, e.g. german or english_2026-01")
	var voices WriteDirectories
	flags.Var(&voices, "voice", "voice to download (repeatable; default: the model's default voice)")
	all := flags.Bool("all-voices", false, "download every voice of the model")
	if err := flags.Parse(args[1:]); err != nil {
		return fmt.Errorf("aae speech: flags: %w", err)
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("aae speech: unexpected arguments %v", flags.Args())
	}
	encoder := json.NewEncoder(stdout)
	if command == "list" {
		models, err := SpeechModels(*root)
		if err != nil {
			return err
		}
		for _, m := range models {
			if err := encoder.Encode(m); err != nil {
				return fmt.Errorf("aae speech: write result: %w", err)
			}
		}
		return nil
	}
	if *root == "" || *model == "" {
		return fmt.Errorf("aae speech download: --speech-models and --model are required")
	}
	if err := os.MkdirAll(*root, 0o750); err != nil {
		return fmt.Errorf("aae speech download: %w", err)
	}
	m, err := pockettts.LookupModel(*model)
	if err != nil {
		return fmt.Errorf("aae speech download: %w", err)
	}
	ids := []string(voices)
	if *all {
		ids = ids[:0]
		for _, v := range m.Voices {
			ids = append(ids, v.ID)
		}
	}
	files, err := download.Files(m, ids)
	if err != nil {
		return fmt.Errorf("aae speech download: %w", err)
	}
	for _, f := range files {
		if err := download.File(ctx, *root, f, download.Options{}); err != nil {
			return fmt.Errorf("aae speech download: %w", err)
		}
		if err := encoder.Encode(map[string]any{"path": filepath.Join(*root, filepath.FromSlash(f.Path)), "bytes": f.Size, "sha256": f.SHA256}); err != nil {
			return fmt.Errorf("aae speech: write result: %w", err)
		}
	}
	return nil
}
