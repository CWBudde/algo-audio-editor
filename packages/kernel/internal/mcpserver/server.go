//go:build !js

// Package mcpserver is a native, stdio-only MCP front end over the kernel.
package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/automation"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/buildinfo"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/engine"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/speech"
	pockettts "github.com/cwbudde/go-pocket-tts"
	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const maxDocuments = 8

type document struct {
	id     string
	kernel *engine.Engine
	info   protocol.DocumentInfoResult
}

// Session owns engine instances and routing identities, not samples. All
// handlers share one mutex because Engine is deliberately single-threaded.
type Session struct {
	mu        sync.Mutex
	server    *mcp.Server
	policy    *automation.FilePolicy
	documents map[string]*document
	sequence  uint64
	// speechRoot holds the speech models; speaker loads them on demand.
	speechRoot string
	speaker    *speech.Synthesizer
}

type documentArgs struct {
	DocumentID string `json:"documentId" jsonschema:"session document id returned by open_document"`
}

type rangeArgs struct {
	documentArgs
	Range *protocol.SelectionRange `json:"range,omitempty" jsonschema:"optional range in sample frames; omit to use the current selection"`
}

type operationArgs struct {
	documentArgs
	Operation automation.Operation `json:"operation"`
	DryRun    bool                 `json:"dryRun,omitempty" jsonschema:"process/effects only; evaluates then discards the candidate"`
}

type chainArgs struct {
	documentArgs
	Chain automation.Chain `json:"chain"`
}

type exportArgs struct {
	documentArgs
	Path         string  `json:"path"`
	Format       string  `json:"format" jsonschema:"wav, flac or aiff; browser-only codecs are unavailable"`
	BitDepth     int     `json:"bitDepth"`
	Float        bool    `json:"float,omitempty"`
	Scope        string  `json:"scope,omitempty" jsonschema:"document (default) or selection"`
	Dither       string  `json:"dither,omitempty" jsonschema:"none or tpdf"`
	NoiseShaping string  `json:"noiseShaping,omitempty"`
	Seed         *uint32 `json:"seed,omitempty"`
	Overwrite    bool    `json:"overwrite,omitempty" jsonschema:"explicit permission to replace an existing destination"`
}

// New uses the official MCP SDK for negotiation, schema validation, stdio and
// cancellation. No HTTP listener or live-editor session is exposed.
// speechRoot is the speech model directory; empty disables speech.
func New(policy *automation.FilePolicy, speechRoot string) *mcp.Server {
	s := &Session{policy: policy, documents: make(map[string]*document), speechRoot: speechRoot, speaker: speech.NewSynthesizer(speechRoot)}
	s.server = mcp.NewServer(&mcp.Implementation{Name: "algo-audio-editor", Version: buildinfo.Version}, &mcp.ServerOptions{
		Instructions: "Native audio editor. Open local files, inspect document_info/get_statistics and list_operations/list_effects before editing. Ranges use sample frames with exclusive end and a channel bit mask; select_seconds converts seconds to frames. Document summaries link waveform PNG and binary peak resources. Mutations use kernel undo history. Filesystem writes require --allow-write and never overwrite unless explicitly requested. Chains commit each step; failures report the completed prefix.",
	})
	s.registerTools()
	s.registerInspectionTools()
	s.registerPrompts()
	return s.server
}

func addTool[In any](s *Session, name, description string, readOnly bool, handler func(context.Context, In) (any, error)) {
	mcp.AddTool(s.server, &mcp.Tool{Name: name, Description: description, Annotations: &mcp.ToolAnnotations{ReadOnlyHint: readOnly}},
		func(ctx context.Context, _ *mcp.CallToolRequest, input In) (*mcp.CallToolResult, any, error) {
			s.mu.Lock()
			defer s.mu.Unlock()
			ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
			defer cancel()
			if err := ctx.Err(); err != nil {
				return nil, nil, err
			}
			output, err := handler(ctx, input)
			if err != nil {
				// Preserve a partially completed chain in structured output. Tool
				// errors are distinct from JSON-RPC protocol errors.
				message := err.Error() + " Review document_info, history and list_operations before retrying."
				return &mcp.CallToolResult{
					IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: message}},
					StructuredContent: map[string]any{"error": message, "result": output},
				}, nil, nil
			}
			return nil, output, nil
		})
}

func (s *Session) get(id string) (*document, error) {
	d := s.documents[id]
	if d == nil {
		return nil, fmt.Errorf("document: unknown id %q; call list_documents or open_document", id)
	}
	if _, err := automation.Call(d.kernel, protocol.MethodDocumentInfo, nil, nil, &d.info); err != nil {
		return nil, err
	}
	return d, nil
}

func (s *Session) summary(d *document) (any, error) {
	var metadata protocol.MetadataResult
	if _, err := automation.Call(d.kernel, protocol.MethodMetadataGet, protocol.MetadataGetParams{DocumentID: d.info.DocumentID}, nil, &metadata); err != nil {
		return nil, err
	}
	info := d.info
	info.DocumentID = d.id
	return map[string]any{"document": info, "durationSeconds": float64(info.Frames) / float64(info.SampleRate), "metadata": external(d, metadata), "summaryURI": summaryURI(d.id), "waveformURI": waveformURI(d.id), "peaksURI": peaksURI(d.id)}, nil
}

// external substitutes routing ids in control results while leaving all audio
// data at the binary boundary. Marshal failures are impossible for kernel
// protocol values, but are still reported as a control error.
func external(d *document, value any) any {
	data, err := json.Marshal(value)
	if err != nil {
		return map[string]any{"error": fmt.Sprintf("encode result: %v", err)}
	}
	var result any
	if err := json.Unmarshal(data, &result); err != nil {
		return map[string]any{"error": fmt.Sprintf("decode result: %v", err)}
	}
	var visit func(any)
	visit = func(v any) {
		switch item := v.(type) {
		case map[string]any:
			if _, ok := item["documentId"]; ok {
				item["documentId"] = d.id
			}
			for _, child := range item {
				visit(child)
			}
		case []any:
			for _, child := range item {
				visit(child)
			}
		}
	}
	visit(result)
	return result
}

func (s *Session) selection(d *document, requested *protocol.SelectionRange) (protocol.SelectionResult, error) {
	selection := protocol.SelectionResult{DocumentID: d.info.DocumentID}
	if requested != nil {
		selection.SelectionRange = *requested
		return selection, nil
	}
	_, err := automation.Call(d.kernel, protocol.MethodSelectionGet, protocol.SelectionGetParams{DocumentID: d.info.DocumentID}, nil, &selection)
	return selection, err
}

func (s *Session) registerTools() {
	addTool(s, "open_document", "Open a local WAV/FLAC/AIFF/MP3 in an independent kernel session. At most eight open documents and 128 MiB per input file.", false,
		func(_ context.Context, input struct {
			Path string `json:"path"`
		},
		) (any, error) {
			if len(s.documents) >= maxDocuments {
				return nil, fmt.Errorf("open_document: limit of %d reached; close_document first", maxDocuments)
			}
			data, err := automation.ReadFile(input.Path, automation.MaxInputBytes)
			if err != nil {
				return nil, err
			}
			d := &document{kernel: engine.New()}
			if _, err := automation.Call(d.kernel, protocol.MethodDocumentOpen, protocol.DocumentOpenParams{Name: filepath.Base(input.Path)}, data, &d.info); err != nil {
				return nil, err
			}
			s.sequence++
			d.id = fmt.Sprintf("document-%d", s.sequence)
			s.documents[d.id] = d
			s.addSummaryResource(d)
			s.addInspectionResources(d)
			return s.summary(d)
		})
	addTool(s, "close_document", "Release a session document and its history. Unsaved edits are discarded; export first if needed.", false,
		func(_ context.Context, input documentArgs) (any, error) {
			if _, err := s.get(input.DocumentID); err != nil {
				return nil, err
			}
			delete(s.documents, input.DocumentID)
			s.server.RemoveResources(summaryURI(input.DocumentID), waveformURI(input.DocumentID), peaksURI(input.DocumentID))
			s.server.RemoveResourceTemplates(waveformTemplate(input.DocumentID), peaksTemplate(input.DocumentID))
			return map[string]any{"closed": input.DocumentID}, nil
		})
	addTool(s, "list_documents", "List open documents in deterministic id order.", true,
		func(_ context.Context, _ struct{}) (any, error) {
			ids := make([]string, 0, len(s.documents))
			for id := range s.documents {
				ids = append(ids, id)
			}
			sort.Strings(ids)
			items := make([]any, 0, len(ids))
			for _, id := range ids {
				d, err := s.get(id)
				if err != nil {
					return nil, err
				}
				info, err := s.summary(d)
				if err != nil {
					return nil, err
				}
				items = append(items, info)
			}
			return map[string]any{"documents": items}, nil
		})
	addTool(s, "document_info", "Document dimensions, duration, source format and metadata.", true,
		func(_ context.Context, input documentArgs) (any, error) {
			d, err := s.get(input.DocumentID)
			if err != nil {
				return nil, err
			}
			return s.summary(d)
		})
	addTool(s, "select_range", "Set an exclusive sample-frame range and nonzero channelMask (bit 0 is channel 0). A cursor causes processing/statistics to use the whole document.", false,
		func(_ context.Context, input struct {
			documentArgs
			Range protocol.SelectionRange `json:"range"`
		},
		) (any, error) {
			d, err := s.get(input.DocumentID)
			if err != nil {
				return nil, err
			}
			var result protocol.SelectionResult
			_, err = automation.Call(d.kernel, protocol.MethodSelectionSet, protocol.SelectionSetParams{DocumentID: d.info.DocumentID, SelectionRange: input.Range}, nil, &result)
			return external(d, result), err
		})
	addTool(s, "get_statistics", "Kernel peak, RMS, DC, crest factor, clipping and integrated LUFS for the range/current selection. LUFS is null when unavailable. No samples are returned.", true,
		func(ctx context.Context, input rangeArgs) (any, error) {
			d, err := s.get(input.DocumentID)
			if err != nil {
				return nil, err
			}
			selection, err := s.selection(d, input.Range)
			if err != nil {
				return nil, err
			}
			result, _, err := automation.Analyze(ctx, d.kernel, protocol.AnalysisStartParams{SelectionResult: selection, Kind: "statistics"})
			return external(d, result), err
		})
	addTool(s, "detect_clipping", "Read-only kernel clipping scan. Reports count of clipped regions and per-channel statistics; does not add markers.", true,
		func(ctx context.Context, input struct {
			rangeArgs
			Threshold float64 `json:"threshold" jsonschema:"linear amplitude threshold, normally 1"`
		},
		) (any, error) {
			d, err := s.get(input.DocumentID)
			if err != nil {
				return nil, err
			}
			selection, err := s.selection(d, input.Range)
			if err != nil {
				return nil, err
			}
			result, _, err := automation.Analyze(ctx, d.kernel, protocol.AnalysisStartParams{SelectionResult: selection, Kind: "clipping", Threshold: input.Threshold})
			return external(d, result), err
		})
	addTool(s, "apply_operation", "Apply one recorded UI operation. Discover params using list_operations. Each audio change is undoable. dryRun supports processing/effects and returns the evaluated candidate without committing.", false,
		func(ctx context.Context, input operationArgs) (any, error) {
			d, err := s.get(input.DocumentID)
			if err != nil {
				return nil, err
			}
			result, err := automation.Apply(ctx, d.kernel, d.info.DocumentID, input.Operation, input.DryRun, s.speaker)
			return operationResult(d, result), err
		})
	addTool(s, "apply_chain", "Run a version 1 JSON operation chain (at most 64 operations). Each step commits separately. Failure returns the completed prefix; use history/undo to revert it.", false,
		func(ctx context.Context, input chainArgs) (any, error) {
			d, err := s.get(input.DocumentID)
			if err != nil {
				return nil, err
			}
			result, err := automation.ApplyChain(ctx, d.kernel, d.info.DocumentID, input.Chain, s.speaker)
			items := make([]any, 0, len(result.Results))
			for _, item := range result.Results {
				items = append(items, operationResult(d, item))
			}
			return map[string]any{"applied": result.Applied, "results": items, "error": result.Error}, err
		})
	addTool(s, "apply_effect", "Apply an undoable effect graph discovered with list_effects. A dry run evaluates and discards the candidate.", false,
		func(ctx context.Context, input struct {
			rangeArgs
			Graph  protocol.EffectGraph `json:"graph"`
			Wet    *float64             `json:"wet,omitempty"`
			Bypass bool                 `json:"bypass,omitempty"`
			DryRun bool                 `json:"dryRun,omitempty"`
		},
		) (any, error) {
			d, err := s.get(input.DocumentID)
			if err != nil {
				return nil, err
			}
			selection, err := s.selection(d, input.Range)
			if err != nil {
				return nil, err
			}
			params := map[string]any{"start": selection.Start, "end": selection.End, "channelMask": selection.ChannelMask, "graph": input.Graph, "bypass": input.Bypass}
			if input.Wet != nil {
				params["wet"] = *input.Wet
			}
			result, err := automation.Apply(ctx, d.kernel, d.info.DocumentID, automation.Operation{Method: protocol.MethodEffectsApply, Params: params}, input.DryRun, s.speaker)
			return operationResult(d, result), err
		})
	s.registerSpeechTools()
	addTool(s, "list_operations", "Discover input schemas derived from Go protocol structs. Omit documentId in params. Missing start/end/channelMask use the current selection; call select_range or supply explicit frame values.", true,
		func(_ context.Context, _ struct{}) (any, error) { return operationSchemas() })
	addTool(s, "list_effects", "Discover effect descriptors, parameter ranges, defaults and presets; supports offset/limit pagination.", true,
		func(_ context.Context, input struct {
			DocumentID string `json:"documentId,omitempty" jsonschema:"optional session document id for sample-rate-specific parameter limits"`
			Offset     int    `json:"offset,omitempty"`
			Limit      int    `json:"limit,omitempty"`
		},
		) (any, error) {
			if input.Offset < 0 || input.Limit < 0 || input.Limit > 20 {
				return nil, fmt.Errorf("list_effects: offset must be nonnegative and limit in [1,20] (default 10)")
			}
			limit := input.Limit
			if limit == 0 {
				limit = 10
			}
			var result protocol.EffectsListResult
			params := protocol.EffectsListParams{}
			if input.DocumentID != "" {
				d, err := s.get(input.DocumentID)
				if err != nil {
					return nil, err
				}
				params.SampleRate = float64(d.info.SampleRate)
			}
			if _, err := automation.Call(engine.New(), protocol.MethodEffectsList, params, nil, &result); err != nil {
				return nil, err
			}
			start := min(input.Offset, len(result.Effects))
			end := min(start+limit, len(result.Effects))
			return map[string]any{"effects": result.Effects[start:end], "total": len(result.Effects), "nextOffset": end}, nil
		})
	for _, item := range []struct{ name, method string }{{"undo", protocol.MethodEditUndo}, {"redo", protocol.MethodEditRedo}, {"history", protocol.MethodHistoryList}} {
		addTool(s, item.name, "Inspect/navigate the kernel history; audio changes preserve the same history as the UI.", item.name == "history",
			func(_ context.Context, input documentArgs) (any, error) {
				d, err := s.get(input.DocumentID)
				if err != nil {
					return nil, err
				}
				var result any
				_, err = automation.Call(d.kernel, item.method, protocol.HistoryListParams{DocumentID: d.info.DocumentID}, nil, &result)
				return external(d, result), err
			})
	}
	for _, save := range []bool{false, true} {
		name := "export_document"
		if save {
			name = "save_document"
		}
		addTool(s, name, "Encode through the Go kernel and write under --allow-write. wav/flac/aiff only. Never overwrites without overwrite:true. save_document requires whole-document scope and marks history saved after success.", false,
			func(ctx context.Context, input exportArgs) (any, error) { return s.export(ctx, input, save) })
	}
}

// Avoid repeating every marker and the full undo stack after each chain step.
// The client can inspect history/document_info explicitly when needed.
func operationResult(d *document, result automation.OperationResult) any {
	output := map[string]any{"dryRun": result.DryRun}
	if edit := result.Edit; edit != nil {
		output["changed"], output["document"], output["selection"] = edit.Changed, edit.Document, edit.Selection
		output["history"] = map[string]any{
			"currentStateId": edit.History.CurrentStateID,
			"dirty":          edit.History.Dirty, "canUndo": edit.History.CanUndo, "canRedo": edit.History.CanRedo,
		}
	}
	if candidate := result.Candidate; candidate != nil {
		output["candidate"] = map[string]any{
			"state": candidate.State, "operation": candidate.Operation, "geometry": candidate.Candidate,
			"peak": candidate.Peak, "nonFinite": candidate.NonFinite, "gainDb": candidate.GainDB,
			"inputLUFS": candidate.InputLUFS, "predictedLUFS": candidate.PredictedLUFS, "outputLUFS": candidate.OutputLUFS,
		}
	}
	return external(d, output)
}

func operationSchemas() (any, error) {
	edit, err := jsonschema.For[protocol.EditApplyParams](nil)
	if err != nil {
		return nil, fmt.Errorf("edit schema: %w", err)
	}
	process, err := jsonschema.For[protocol.ProcessStartParams](nil)
	if err != nil {
		return nil, fmt.Errorf("process schema: %w", err)
	}
	effects, err := jsonschema.For[protocol.EffectsPreviewParams](nil)
	if err != nil {
		return nil, fmt.Errorf("effects schema: %w", err)
	}
	speak, err := jsonschema.For[protocol.SpeechGenerateParams](nil)
	if err != nil {
		return nil, fmt.Errorf("speech schema: %w", err)
	}
	catalog, err := pockettts.LoadCatalog()
	if err != nil {
		return nil, fmt.Errorf("speech schema: %w", err)
	}
	speak.Properties["model"].Enum = make([]any, 0, len(catalog.Models))
	for _, m := range catalog.Models {
		speak.Properties["model"].Enum = append(speak.Properties["model"].Enum, m.Name)
	}
	edit.Properties["operation"].Enum = []any{"delete", "cut", "copy", "paste-insert", "paste-replace", "paste-mix", "crop", "insert-silence", "duplicate", "swap-channels", "mute"}
	process.Properties["operation"].Enum = []any{"gain", "normalize-peak", "normalize-loudness", "fade-in", "fade-out", "crossfade", "reverse", "invert", "remove-dc", "mono-to-stereo", "stereo-to-mono", "resample", "generate", "spectral-attenuate", "spectral-remove", "spectral-heal", "noise-reduce", "remove-clicks", "declip", "time-stretch", "remove-hum"}
	process.Properties["curve"].Enum = []any{"linear", "equal-power", "logarithmic", "s-curve"}
	process.Properties["quality"].Enum = []any{"fast", "balanced", "best"}
	process.Properties["generator"].Enum = []any{"silence", "sine", "white-noise", "pink-noise", "linear-sweep", "log-sweep"}
	items := map[string]*jsonschema.Schema{protocol.MethodEditApply: edit, protocol.MethodProcessStart: process, protocol.MethodEffectsApply: effects, protocol.ChainSpeechGenerate: speak}
	for _, schema := range items {
		delete(schema.Properties, "documentId")
		filtered := make([]string, 0, len(schema.Required))
		for _, field := range schema.Required {
			if field != "documentId" && field != "start" && field != "end" && field != "channelMask" && field != "gainDb" {
				filtered = append(filtered, field)
			}
		}
		schema.Required = filtered
	}
	return map[string]any{"chainVersion": 1, "protocolVersion": protocol.Version, "methods": items}, nil
}

func (s *Session) export(ctx context.Context, input exportArgs, save bool) (any, error) {
	d, err := s.get(input.DocumentID)
	if err != nil {
		return nil, err
	}
	if save && input.Scope != "" && input.Scope != "document" {
		return nil, fmt.Errorf("save_document: requires whole-document scope; use export_document for a selection")
	}
	params := protocol.DocumentExportParams{
		DocumentID: d.info.DocumentID, Format: input.Format,
		BitDepth: input.BitDepth, Float: input.Float, Scope: input.Scope, Dither: input.Dither, NoiseShaping: input.NoiseShaping, Seed: input.Seed,
	}
	var info protocol.DocumentExportInfo
	data, err := automation.Call(d.kernel, protocol.MethodDocumentExport, params, nil, &info)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("export: %w", err)
	}
	path, err := s.policy.Write(input.Path, data, input.Overwrite)
	if err != nil {
		return nil, err
	}
	if save {
		var history protocol.HistoryListResult
		if _, err := automation.Call(d.kernel, protocol.MethodHistoryList, protocol.HistoryListParams{DocumentID: d.info.DocumentID}, nil, &history); err != nil {
			return nil, err
		}
		if _, err := automation.Call(d.kernel, protocol.MethodMarkSaved, protocol.MarkSavedParams{DocumentID: d.info.DocumentID, StateID: history.CurrentStateID}, nil, nil); err != nil {
			return nil, err
		}
	}
	return map[string]any{"documentId": d.id, "path": path, "dataBytes": len(data), "mimeType": info.MimeType, "markedSaved": save}, nil
}

func summaryURI(id string) string { return "aae://documents/" + id + "/summary" }

func (s *Session) addSummaryResource(d *document) {
	uri := summaryURI(d.id)
	s.server.AddResource(&mcp.Resource{URI: uri, Name: d.id, MIMEType: "application/json", Description: "Current kernel document dimensions and metadata"},
		func(_ context.Context, _ *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
			s.mu.Lock()
			defer s.mu.Unlock()
			current, err := s.get(d.id)
			if err != nil {
				return nil, mcp.ResourceNotFoundError(uri)
			}
			summary, err := s.summary(current)
			if err != nil {
				return nil, err
			}
			data, err := json.Marshal(summary)
			if err != nil {
				return nil, fmt.Errorf("resource: encode summary: %w", err)
			}
			return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{{URI: uri, MIMEType: "application/json", Text: string(data)}}}, nil
		})
}

func (s *Session) registerPrompts() {
	for _, item := range []struct{ name, text string }{
		{"mastering_check", "Open the requested file, call document_info and get_statistics, and report headroom, clipping and integrated LUFS availability. Discover processing params with list_operations. Propose any processing before applying it and use dryRun for processing/effects. Export only to an explicitly authorized directory and path."},
		{"podcast_cleanup", "Open the requested recording, inspect statistics and listen to the user's goals. Discover effect descriptors and operation schemas before choosing parameters. Apply a short, explained chain through the kernel, inspect the result and keep its undo history. Export only to an explicitly authorized destination; do not overwrite without consent."},
		{"batch_convert", "For each user-specified file, open_document, inspect its format, apply the same version 1 chain and export_document to the requested allowed directory. Check each result and report failures with completed operation counts. Close documents when done. Do not replace existing files without explicit consent."},
	} {
		s.server.AddPrompt(&mcp.Prompt{Name: item.name, Description: item.text},
			func(_ context.Context, _ *mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
				return &mcp.GetPromptResult{Messages: []*mcp.PromptMessage{{Role: "user", Content: &mcp.TextContent{Text: item.text}}}}, nil
			})
	}
}
