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

// maxProcessBatchSteps bounds work before the worker yields to cancellation.
// Each individual processing step still scans at most BlockFrames frames.
const maxProcessBatchSteps = 4

type processingJob struct {
	result       protocol.ProcessJobResult
	builder      processing.Stepper
	identity     bool
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
		protocol.MethodProcessStart, protocol.MethodProcessStep, protocol.MethodProcessStepBatch, protocol.MethodProcessCancel,
		protocol.MethodProcessCommit:
		return nil
	case protocol.MethodProcessExportCandidate:
		return nil
	case protocol.MethodEffectsList, protocol.MethodEffectsResponse, protocol.MethodEffectsPreviewMeters:
		return nil
	case protocol.MethodMetersConfigure, protocol.MethodAnalysisStart, protocol.MethodAnalysisStep, protocol.MethodAnalysisCancel, protocol.MethodAnalysisSpectrum:
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
	if err := validateProcessParameters(p); err != nil {
		return protocol.ProcessJobResult{}, err
	}
	if e.document.Frames() == 0 && p.Operation != "generate" {
		return protocol.ProcessJobResult{}, fmt.Errorf("%s: document is empty", method)
	}
	if e.processSequence == math.MaxUint64 {
		return protocol.ProcessJobResult{}, fmt.Errorf("%s: job identity exhausted", method)
	}
	if e.history == nil {
		return protocol.ProcessJobResult{}, fmt.Errorf("%s: history is not initialized", method)
	}
	selection := p.SelectionRange
	if p.Operation == "mono-to-stereo" || p.Operation == "stereo-to-mono" || p.Operation == "resample" {
		selection = protocol.SelectionRange{Start: 0, End: e.document.Frames(), ChannelMask: (1 << e.document.Channels()) - 1}
	} else if selection.Start == selection.End && p.Operation != "crossfade" && p.Operation != "generate" {
		selection.Start, selection.End = 0, e.document.Frames()
	}
	builder, err := e.prepareProcess(p, selection)
	if err != nil {
		return protocol.ProcessJobResult{}, fmt.Errorf("%s: prepare processing: %w", method, err)
	}
	before := cloneEditor(e.editor)
	before.selection = p.SelectionRange
	phase, phaseCount, gainResolved, gainDB := "processing", 1, true, p.GainDB
	var target *float64
	if p.Operation == "normalize-peak" || p.Operation == "normalize-loudness" {
		phase, phaseCount, gainResolved, gainDB = "analyzing", 2, false, 0
		if p.Operation == "normalize-loudness" {
			phaseCount = 3
		}
		value := *p.Target
		target = &value
	}
	e.processSequence++
	e.processJob = &processingJob{
		result: protocol.ProcessJobResult{
			SelectionResult: protocol.SelectionResult{DocumentID: p.DocumentID, SelectionRange: selection},
			JobID:           fmt.Sprintf("process-%d", e.processSequence), State: "running", Operation: p.Operation,
			GainDB: gainDB, TotalFrames: selection.End - selection.Start,
			Phase: phase, PhaseCount: phaseCount, GainResolved: gainResolved, Target: target,
		},
		builder: builder, before: historySnapshot{document: e.document, editor: before},
		historyState: e.history.CurrentID(),
	}
	e.refreshProcessStatus(e.processJob)
	if provider, ok := builder.(interface{ Progress() processing.Progress }); ok {
		progress := provider.Progress()
		e.processJob.result.ProcessedFrames, e.processJob.result.TotalFrames = progress.FramesDone, progress.FramesTotal
	}
	return e.processJob.result, nil
}

func validateProcessParameters(p protocol.ProcessStartParams) error {
	const method = protocol.MethodProcessStart
	if p.Operation == "gain" {
		if p.Target != nil || math.IsNaN(p.GainDB) || math.IsInf(p.GainDB, 0) || p.GainDB < -120 || p.GainDB > 60 {
			return fmt.Errorf("%s: gain requires finite dB in [-120, 60] and no target", method)
		}
		return nil
	}
	minimum := -120.0
	switch p.Operation {
	case "normalize-peak":
	case "normalize-loudness":
		minimum = -69
	case "spectral-attenuate":
		if p.Target != nil || math.IsNaN(p.GainDB) || math.IsInf(p.GainDB, 0) || p.GainDB < -120 || p.GainDB > 0 {
			return fmt.Errorf("%s: attenuation must be in [-120,0] dB", method)
		}
		return nil
	case "spectral-remove", "spectral-heal", "noise-reduce", "remove-clicks", "declip", "time-stretch", "remove-hum", "fade-in", "fade-out", "crossfade", "reverse", "invert", "remove-dc", "mono-to-stereo", "stereo-to-mono", "extract-channel", "resample", "generate":
		if p.Target != nil || p.GainDB != 0 {
			return fmt.Errorf("%s: operation does not accept gain or normalization target", method)
		}
		return nil // Operation-specific validation occurs before allocation in its factory.
	default:
		return fmt.Errorf("%s: unsupported operation %q", method, p.Operation)
	}
	if p.Target == nil || math.IsNaN(*p.Target) || math.IsInf(*p.Target, 0) || *p.Target < minimum || *p.Target > 0 {
		return fmt.Errorf("%s: normalization requires a finite target in [%g, 0]", method, minimum)
	}
	return nil
}

func (e *Engine) prepareProcess(p protocol.ProcessStartParams, selection protocol.SelectionRange) (processing.Stepper, error) {
	selected := ops.Range{Start: selection.Start, End: selection.End, ChannelMask: selection.ChannelMask}
	limits := processing.Limits{MaxOutputBytes: maxProcessOutputBytes}
	if p.Operation == "gain" {
		return processing.NewBuilder(e.document, selected, processing.Gain{DB: p.GainDB}, limits)
	}
	if p.Operation == "normalize-peak" || p.Operation == "normalize-loudness" {
		return processing.NewNormalizer(e.document, selected, p.Operation, *p.Target, limits)
	}
	if p.Seed > math.MaxUint32 {
		return nil, fmt.Errorf("noise seed must be uint32")
	}
	if p.Operation == "resample" && (p.SampleRate < MinSampleRate || p.SampleRate > MaxSampleRate) {
		return nil, fmt.Errorf("sample rate must be in [%d, %d]", MinSampleRate, MaxSampleRate)
	}
	if p.Operation == "mono-to-stereo" || p.Operation == "stereo-to-mono" || p.Operation == "resample" {
		selected = ops.Range{Start: p.Start, End: p.End, ChannelMask: p.ChannelMask}
	}
	restorationSettings, err := e.prepareRestorationSettings(p, selected)
	if err != nil {
		return nil, err
	}
	return processing.NewOperation(e.document, selected, processing.Settings{
		Operation: p.Operation, Curve: p.Curve, DurationFrames: p.DurationFrames, Restoration: restorationSettings,
		ChannelMode: p.ChannelMode, Channel: p.Channel, SampleRate: p.SampleRate, Quality: p.Quality,
		Generator: p.Generator, Frequency: p.Frequency, EndFrequency: p.EndFrequency, LevelDB: p.LevelDB, Seed: p.Seed,
	}, limits)
}

func (e *Engine) refreshProcessStatus(job *processingJob) {
	if provider, ok := job.builder.(interface {
		Status() processing.NormalizationStatus
	}); ok {
		status := provider.Status()
		job.result.Phase, job.result.PhaseIndex, job.result.PhaseCount = status.Phase, status.PhaseIndex, status.PhaseCount
		job.result.GainDB, job.result.GainResolved, job.result.InputPeak = status.GainDB, status.GainResolved, status.InputPeak
		job.result.PlanningSteps = status.PlanningSteps
		job.result.InputLUFS, job.result.PredictedLUFS, job.result.OutputLUFS = status.InputLUFS, status.PredictedLUFS, status.OutputLUFS
		job.result.UnchangedReason = status.UnchangedReason
	}
	format := protocol.ProcessCandidate{SampleRate: e.document.SampleRate(), Channels: e.document.Channels(), Frames: e.document.Frames(), SelectionRange: job.result.SelectionRange}
	if provider, ok := job.builder.(interface{ OutputFormat() (int, int, int64) }); ok {
		format.SampleRate, format.Channels, format.Frames = provider.OutputFormat()
	}
	if provider, ok := job.builder.(interface{ OutputSelection() ops.Range }); ok {
		selection := provider.OutputSelection()
		format.SelectionRange = protocol.SelectionRange{Start: selection.Start, End: selection.End, ChannelMask: selection.ChannelMask}
	}
	job.result.Candidate = &format
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
	e.refreshProcessStatus(job)
	job.result.Peak, job.result.NonFinite = job.builder.Peak()
	if math.IsNaN(job.result.Peak) || math.IsInf(job.result.Peak, 0) {
		job.result.Peak, job.result.NonFinite = 0, true
	}
	if progress.Done {
		job.identity = job.builder.Identity()
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

// stepProcessBatch preserves every single-step validation and failure path.
// A phase boundary is an immediate return, even when batch capacity remains:
// callers must observe analysis/planning completion before rendering/verification.
func (e *Engine) stepProcessBatch(p protocol.ProcessJobParams) (protocol.ProcessJobResult, error) {
	phase := -1
	if job := e.processJob; job != nil {
		phase = job.result.PhaseIndex
	}
	var result protocol.ProcessJobResult
	for range maxProcessBatchSteps {
		var err error
		result, err = e.stepProcess(p)
		if err != nil {
			return protocol.ProcessJobResult{}, fmt.Errorf("%s: %w", protocol.MethodProcessStepBatch, err)
		}
		if result.State != "running" || result.PhaseIndex != phase {
			return result, nil
		}
	}
	return result, nil
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
	if job.result.Operation == "extract-channel" {
		return protocol.EditResult{}, fmt.Errorf("%s: extraction must be opened in another window", method)
	}
	if job.identity {
		e.discardProcess(job)
		return e.editResult(false), nil
	}
	if e.documentSequence == math.MaxUint64 {
		return protocol.EditResult{}, fmt.Errorf("%s: document identity exhausted", method)
	}
	editor := cloneEditor(e.editor)
	editor.selection = job.result.SelectionRange
	if job.result.Candidate != nil && job.result.Operation != "gain" && job.result.Operation != "normalize-peak" && job.result.Operation != "normalize-loudness" {
		editor.selection = job.result.Candidate.SelectionRange
	}
	label := "Gain"
	switch job.result.Operation {
	case "normalize-peak":
		label = "Normalize peak"
	case "normalize-loudness":
		label = "Normalize loudness"
	case "effects":
		label = "Effects"
	default:
		if job.result.Operation != "gain" {
			label = editHistoryLabel(job.result.Operation)
		}
	}
	staged, err := e.history.StagePush(label, job.before, historySnapshot{document: job.candidate, editor: editor})
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
