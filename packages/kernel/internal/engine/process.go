package engine

import (
	"context"
	"fmt"
	"math"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	processing "github.com/cwbudde/algo-audio-editor/packages/kernel/internal/process"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

const maxProcessOutputBytes = 512 << 20

type processingJob struct {
	result       protocol.ProcessJobResult
	builder      *processing.Builder
	candidate    audiobuf.Document
	before       historySnapshot
	historyState string
}

// Job locks protect even callers bypassing the frontend operation fence. Read
// methods keep observing the committed document, never the private candidate.
func (e *Engine) guardProcessing(method string) error {
	if e.processJob == nil {
		return nil
	}
	switch method {
	case protocol.MethodHello, protocol.MethodDocumentMemory, protocol.MethodDocumentInfo,
		protocol.MethodDocumentExport, protocol.MethodEditState, protocol.MethodPreparePaste,
		protocol.MethodHistoryList, protocol.MethodSelectionGet, protocol.MethodSelectionSnap,
		protocol.MethodTimelineGet, protocol.MethodTimelineExport, protocol.MethodPeaksGet,
		protocol.MethodEngineConfigure, protocol.MethodTransportStop, protocol.MethodTransportPlay,
		protocol.MethodProcessStart, protocol.MethodProcessStep, protocol.MethodProcessCancel,
		protocol.MethodProcessCommit:
		return nil
	default:
		return fmt.Errorf("%s: processing job is active", method)
	}
}

func (e *Engine) startProcess(p protocol.ProcessStartParams) (protocol.ProcessJobResult, error) {
	const method = protocol.MethodProcessStart
	if err := e.validateDocumentID(method, p.DocumentID); err != nil {
		return protocol.ProcessJobResult{}, err
	}
	if e.processJob != nil {
		return protocol.ProcessJobResult{}, fmt.Errorf("%s: processing job is already active", method)
	}
	if err := e.validateEditorRange(method, p.Start, p.End); err != nil {
		return protocol.ProcessJobResult{}, err
	}
	if err := e.validateChannelMask(method, p.ChannelMask); err != nil {
		return protocol.ProcessJobResult{}, err
	}
	if p.Operation != "gain" || math.IsNaN(p.GainDB) || math.IsInf(p.GainDB, 0) || p.GainDB < -120 || p.GainDB > 60 {
		return protocol.ProcessJobResult{}, fmt.Errorf("%s: gain requires finite dB in [-120, 60]", method)
	}
	if e.document.Frames() == 0 {
		return protocol.ProcessJobResult{}, fmt.Errorf("%s: document is empty", method)
	}
	if e.processSequence == math.MaxUint64 {
		return protocol.ProcessJobResult{}, fmt.Errorf("%s: job identity exhausted", method)
	}
	if e.history == nil {
		return protocol.ProcessJobResult{}, fmt.Errorf("%s: history is not initialized", method)
	}
	selection := p.SelectionRange
	if selection.Start == selection.End {
		selection.Start, selection.End = 0, e.document.Frames()
	}
	builder, err := processing.NewBuilder(e.document, ops.Range{Start: selection.Start, End: selection.End, ChannelMask: selection.ChannelMask}, processing.Gain{DB: p.GainDB}, processing.Limits{MaxOutputBytes: maxProcessOutputBytes})
	if err != nil {
		return protocol.ProcessJobResult{}, fmt.Errorf("%s: prepare processing: %w", method, err)
	}
	before := cloneEditor(e.editor)
	before.selection = p.SelectionRange
	e.processSequence++
	e.processJob = &processingJob{
		result: protocol.ProcessJobResult{
			SelectionResult: protocol.SelectionResult{DocumentID: p.DocumentID, SelectionRange: selection},
			JobID:           fmt.Sprintf("process-%d", e.processSequence), State: "running", Operation: p.Operation,
			GainDB: p.GainDB, TotalFrames: selection.End - selection.Start,
		},
		builder: builder, before: historySnapshot{document: e.document, editor: before},
		historyState: e.history.CurrentID(),
	}
	return e.processJob.result, nil
}

func (e *Engine) validateProcessSource(method string, job *processingJob) error {
	if err := e.validateDocumentID(method, job.result.DocumentID); err != nil {
		return err
	}
	if e.history == nil || e.history.CurrentID() != job.historyState {
		return fmt.Errorf("%s: processing source history changed", method)
	}
	return nil
}

func (e *Engine) activeProcess(method string, p protocol.ProcessJobParams) (*processingJob, error) {
	if err := e.validateDocumentID(method, p.DocumentID); err != nil {
		return nil, err
	}
	job := e.processJob
	if job == nil || p.JobID == "" || p.JobID != job.result.JobID {
		return nil, fmt.Errorf("%s: stale or invalid processing job", method)
	}
	if method != protocol.MethodProcessCancel {
		if err := e.validateProcessSource(method, job); err != nil {
			return nil, err
		}
	}
	return job, nil
}

func (e *Engine) cancelledProcessResult(p protocol.ProcessJobParams) (protocol.ProcessJobResult, bool) {
	result := e.cancelledProcess
	if result != nil && result.JobID == p.JobID && result.DocumentID == p.DocumentID && e.editor.documentID == p.DocumentID {
		return *result, true
	}
	return protocol.ProcessJobResult{}, false
}

func (e *Engine) stepProcess(p protocol.ProcessJobParams) (protocol.ProcessJobResult, error) {
	if result, ok := e.cancelledProcessResult(p); ok {
		return result, nil
	}
	job, err := e.activeProcess(protocol.MethodProcessStep, p)
	if err != nil {
		return protocol.ProcessJobResult{}, err
	}
	if job.result.State == "ready" {
		return job.result, nil
	}
	progress, err := job.builder.Step(context.Background())
	if err != nil {
		e.discardProcess(job)
		return protocol.ProcessJobResult{}, fmt.Errorf("process.step: process block: %w", err)
	}
	job.result.ProcessedFrames, job.result.TotalFrames = progress.FramesDone, progress.FramesTotal
	job.result.Peak, job.result.NonFinite = job.builder.Peak()
	if math.IsNaN(job.result.Peak) || math.IsInf(job.result.Peak, 0) {
		job.result.Peak, job.result.NonFinite = 0, true
	}
	if progress.Done {
		candidate, err := job.builder.Result()
		if err != nil {
			e.discardProcess(job)
			return protocol.ProcessJobResult{}, fmt.Errorf("process.step: finish document: %w", err)
		}
		job.candidate, job.result.State = candidate, "ready"
		job.builder.Cancel()
		job.builder = nil
	}
	return job.result, nil
}

// discardProcess releases both workspace and transient render references. It
// never stops ordinary playback that was not replaced by this job's preview.
func (e *Engine) discardProcess(job *processingJob) {
	if job.builder != nil {
		job.builder.Cancel()
	}
	if e.transport != nil && e.transport.previewJobID == job.result.JobID {
		e.transport, e.source = nil, sourceStopped
	}
	e.processJob = nil
}

func (e *Engine) cancelProcess(p protocol.ProcessJobParams) (protocol.ProcessJobResult, error) {
	if result, ok := e.cancelledProcessResult(p); ok {
		return result, nil
	}
	job, err := e.activeProcess(protocol.MethodProcessCancel, p)
	if err != nil {
		return protocol.ProcessJobResult{}, err
	}
	result := job.result
	result.State = "cancelled"
	e.discardProcess(job)
	e.cancelledProcess = &result
	return result, nil
}

func (e *Engine) commitProcess(p protocol.ProcessJobParams) (protocol.EditResult, error) {
	const method = protocol.MethodProcessCommit
	job, err := e.activeProcess(method, p)
	if err != nil {
		return protocol.EditResult{}, err
	}
	if job.result.State != "ready" {
		return protocol.EditResult{}, fmt.Errorf("%s: processing job is not ready", method)
	}
	if job.result.GainDB == 0 {
		e.discardProcess(job)
		return e.editResult(false), nil
	}
	if e.documentSequence == math.MaxUint64 {
		return protocol.EditResult{}, fmt.Errorf("%s: document identity exhausted", method)
	}
	editor := cloneEditor(e.editor)
	editor.selection = job.result.SelectionRange
	staged, err := e.history.StagePush("Gain", job.before, historySnapshot{document: job.candidate, editor: editor})
	if err != nil {
		return protocol.EditResult{}, fmt.Errorf("%s: retain undo history: %w", method, err)
	}
	e.document, e.history = job.candidate, staged
	e.documentSequence++
	editor.documentID = fmt.Sprintf("doc-%d", e.documentSequence)
	e.editor = editor
	e.transport, e.source = nil, sourceStopped
	e.processJob = nil
	return e.editResult(true), nil
}
