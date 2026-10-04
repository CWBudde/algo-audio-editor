// Package automation drives the same control protocol as the editor worker.
// It contains no DSP, codecs, or sample state.
package automation

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/engine"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

const MaxChainOperations = 64

// Operation records a UI protocol method and its control payload. Document
// identity is supplied by the runner. Omitted range fields use the selection
// current at that point in the chain, including after structural edits.
type Operation struct {
	Method string         `json:"method"`
	Params map[string]any `json:"params"`
	// Document ranges adapt to each file and to preceding structural edits.
	// Empty range retains the original current-selection default.
	Range string `json:"range,omitempty"`
}

type Chain struct {
	Version    int         `json:"version"`
	Operations []Operation `json:"operations"`
}

// Call retains the binary boundary: data is never embedded in a JSON result.
func Call(e *engine.Engine, method string, params any, input []byte, result any) ([]byte, error) {
	payload, err := json.Marshal(params)
	if err != nil {
		return nil, fmt.Errorf("%s: encode parameters: %w", method, err)
	}
	var response protocol.Response
	if err := json.Unmarshal(e.CallWithData(method, payload, input), &response); err != nil {
		return nil, fmt.Errorf("%s: decode response: %w", method, err)
	}
	data := e.TakeData()
	if !response.OK {
		return nil, fmt.Errorf("kernel: %s", response.Error)
	}
	if result != nil {
		if err := json.Unmarshal(response.Result, result); err != nil {
			return nil, fmt.Errorf("%s: decode result: %w", method, err)
		}
	}
	return data, nil
}

// DecodeStrict rejects typos and trailing JSON instead of silently ignoring it.
func DecodeStrict(data []byte, target any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	d.UseNumber()
	if err := d.Decode(target); err != nil {
		return fmt.Errorf("decode: %w", err)
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return fmt.Errorf("decode: expected exactly one JSON value")
	}
	return nil
}

func DecodeChain(data []byte) (Chain, error) {
	var chain Chain
	if err := DecodeStrict(data, &chain); err != nil {
		return chain, fmt.Errorf("chain: %w", err)
	}
	if chain.Version != 1 || len(chain.Operations) > MaxChainOperations {
		return chain, fmt.Errorf("chain: version must be 1 and at most %d operations are allowed", MaxChainOperations)
	}
	for i, op := range chain.Operations {
		if err := ValidateOperation(op); err != nil {
			return chain, fmt.Errorf("chain: operation %d: %w", i, err)
		}
	}
	return chain, nil
}

// ValidateOperation checks payload shapes against the actual protocol structs.
func ValidateOperation(op Operation) error {
	if op.Params == nil {
		return fmt.Errorf("operation: params must be an object")
	}
	if _, ok := op.Params["documentId"]; ok {
		return fmt.Errorf("operation: omit documentId from params; the runner supplies it")
	}
	if op.Range != "" && op.Range != "document" {
		return fmt.Errorf("operation: range must be omitted or document")
	}
	if op.Range == "document" {
		for _, key := range []string{"start", "end"} {
			if _, exists := op.Params[key]; exists {
				return fmt.Errorf("operation: document range cannot include %s", key)
			}
		}
	}
	var target any
	switch op.Method {
	case protocol.MethodEditApply:
		target = new(protocol.EditApplyParams)
	case protocol.MethodProcessStart:
		if op.Params["operation"] == "extract-channel" {
			return fmt.Errorf("operation: extract-channel creates a second document and is not supported in chains")
		}
		target = new(protocol.ProcessStartParams)
	case protocol.MethodEffectsApply:
		target = new(protocol.EffectsPreviewParams)
	default:
		return fmt.Errorf("operation: unsupported method %q; use edit.apply, process.start or effects.apply", op.Method)
	}
	payload, err := json.Marshal(op.Params)
	if err != nil {
		return fmt.Errorf("operation: encode: %w", err)
	}
	if err := DecodeStrict(payload, target); err != nil {
		return fmt.Errorf("operation: %s: %w", op.Method, err)
	}
	return nil
}

type OperationResult struct {
	DryRun    bool                       `json:"dryRun"`
	Edit      *protocol.EditResult       `json:"edit,omitempty"`
	Candidate *protocol.ProcessJobResult `json:"candidate,omitempty"`
}

// Apply steps private kernel jobs to completion and uses the kernel's commit
// and history. Cancellation always discards an unfinished candidate. Dry-run
// evaluates a processing/effect candidate but cancels it instead of committing.
func Apply(ctx context.Context, e *engine.Engine, documentID string, op Operation, dryRun bool) (OperationResult, error) {
	result := OperationResult{DryRun: dryRun}
	if err := ValidateOperation(op); err != nil {
		return result, err
	}
	if err := ctx.Err(); err != nil {
		return result, fmt.Errorf("operation: %w", err)
	}
	var selection protocol.SelectionResult
	if _, err := Call(e, protocol.MethodSelectionGet, protocol.SelectionGetParams{DocumentID: documentID}, nil, &selection); err != nil {
		return result, err
	}
	if op.Range == "document" {
		var info protocol.DocumentInfoResult
		if _, err := Call(e, protocol.MethodDocumentInfo, nil, nil, &info); err != nil {
			return result, err
		}
		selection.Start, selection.End, selection.ChannelMask = 0, info.Frames, (1<<info.Channels)-1
	}
	params := make(map[string]any, len(op.Params)+4)
	for key, value := range op.Params {
		params[key] = value
	}
	params["documentId"] = documentID
	for key, value := range map[string]any{"start": selection.Start, "end": selection.End, "channelMask": selection.ChannelMask} {
		if _, exists := params[key]; !exists {
			params[key] = value
		}
	}
	if op.Method == protocol.MethodEditApply {
		if dryRun {
			return result, fmt.Errorf("operation: dry-run is currently supported for processing and effects only")
		}
		// Clipboard versions fence UI requests, but are session-specific. An
		// omitted version binds a recorded paste to this engine's clipboard.
		kind, _ := params["operation"].(string)
		if kind == "paste-insert" || kind == "paste-replace" || kind == "paste-mix" {
			if _, exists := params["clipboardVersion"]; !exists {
				var clipboard protocol.ClipboardInfo
				if _, err := Call(e, protocol.MethodEditState, nil, nil, &clipboard); err != nil {
					return result, err
				}
				params["clipboardVersion"] = clipboard.Version
			}
		}
		result.Edit = new(protocol.EditResult)
		_, err := Call(e, op.Method, params, nil, result.Edit)
		return result, err
	}
	var job protocol.ProcessJobResult
	if _, err := Call(e, op.Method, params, nil, &job); err != nil {
		return result, err
	}
	jobParams := protocol.ProcessJobParams{DocumentID: documentID, JobID: job.JobID}
	defer func() { _, _ = Call(e, protocol.MethodProcessCancel, jobParams, nil, nil) }()
	for job.State == "running" {
		if err := ctx.Err(); err != nil {
			return result, fmt.Errorf("operation: %w", err)
		}
		if _, err := Call(e, protocol.MethodProcessStepBatch, jobParams, nil, &job); err != nil {
			return result, err
		}
	}
	if job.State != "ready" {
		return result, fmt.Errorf("operation: unexpected job state %q", job.State)
	}
	result.Candidate = &job
	if !dryRun {
		if err := ctx.Err(); err != nil {
			return result, fmt.Errorf("operation: %w", err)
		}
		result.Edit = new(protocol.EditResult)
		if _, err := Call(e, protocol.MethodProcessCommit, jobParams, nil, result.Edit); err != nil {
			return result, err
		}
	}
	return result, nil
}

type ChainResult struct {
	Applied int               `json:"applied"`
	Results []OperationResult `json:"results"`
	Error   string            `json:"error,omitempty"`
}

// ApplyChain commits in order, one undo entry per change. Failures report the
// completed prefix; they never imply an all-or-nothing transaction.
func ApplyChain(ctx context.Context, e *engine.Engine, documentID string, chain Chain) (ChainResult, error) {
	result := ChainResult{Results: []OperationResult{}}
	data, err := json.Marshal(chain)
	if err != nil {
		return result, fmt.Errorf("chain: encode: %w", err)
	}
	if _, err := DecodeChain(data); err != nil {
		return result, err
	}
	for i, op := range chain.Operations {
		item, err := Apply(ctx, e, documentID, op, false)
		if err != nil {
			result.Error = fmt.Sprintf("chain: operation %d failed after %d completed operations: %v; inspect history and undo the completed changes if needed", i, result.Applied, err)
			return result, fmt.Errorf("%s", result.Error)
		}
		result.Results = append(result.Results, item)
		result.Applied++
		if item.Edit != nil {
			// The kernel rotates the document identity at every publication to
			// fence stale requests. The session routing id stays unchanged.
			documentID = item.Edit.Document.DocumentID
		}
	}
	return result, nil
}

// Analyze returns control statistics plus a separate optional binary result.
// It never commits clipping markers; read tools remain read-only.
func Analyze(ctx context.Context, e *engine.Engine, params protocol.AnalysisStartParams) (protocol.AnalysisJobResult, []byte, error) {
	var job protocol.AnalysisJobResult
	data, err := Call(e, protocol.MethodAnalysisStart, params, nil, &job)
	if err != nil {
		return job, nil, err
	}
	jobParams := protocol.AnalysisJobParams{DocumentID: params.DocumentID, JobID: job.JobID}
	defer func() { _, _ = Call(e, protocol.MethodAnalysisCancel, jobParams, nil, nil) }()
	for job.State == "running" {
		if err := ctx.Err(); err != nil {
			return job, nil, fmt.Errorf("analysis: %w", err)
		}
		data, err = Call(e, protocol.MethodAnalysisStep, jobParams, nil, &job)
		if err != nil {
			return job, nil, err
		}
	}
	if job.State != "ready" {
		return job, nil, fmt.Errorf("analysis: unexpected job state %q", job.State)
	}
	return job, data, nil
}
