package engine

import (
	"context"
	"encoding/binary"
	"fmt"
	"math"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/memory"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	processing "github.com/cwbudde/algo-audio-editor/packages/kernel/internal/process"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

const maxProcessOutputBytes = memory.StorageLimit

// maxProcessBatchSteps bounds work before the worker yields to cancellation.
// Each individual processing step still scans at most BlockFrames frames.
const maxProcessBatchSteps = 4

type processingJob struct {
	reservedBytes int64
	result        protocol.ProcessJobResult
	builder       processing.Stepper
	identity      bool
	candidate     audiobuf.Document
	before        historySnapshot
	historyState  string
}

func (e *Engine) startProcess(p protocol.ProcessStartParams, input []byte) (protocol.ProcessJobResult, error) {
	const method = protocol.MethodProcessStart
	if err := e.validateDocumentID(method, p.DocumentID); err != nil {
		return protocol.ProcessJobResult{}, err
	}
	audio, err := decodeProcessAudio(p, input)
	if err != nil {
		return protocol.ProcessJobResult{}, fmt.Errorf("%s: %w", method, err)
	}
	if e.jobs.processJob != nil {
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
	if e.doc.document.Frames() == 0 && p.Operation != protocol.OperationGenerate {
		return protocol.ProcessJobResult{}, fmt.Errorf("%s: document is empty", method)
	}
	if e.jobs.processSequence == math.MaxUint64 {
		return protocol.ProcessJobResult{}, fmt.Errorf("%s: job identity exhausted", method)
	}
	if e.historyState.history == nil {
		return protocol.ProcessJobResult{}, fmt.Errorf("%s: history is not initialized", method)
	}
	selection := p.SelectionRange
	if p.Operation == protocol.OperationMonoToStereo || p.Operation == protocol.OperationStereoToMono || p.Operation == protocol.OperationResample {
		selection = protocol.SelectionRange{Start: 0, End: e.doc.document.Frames(), ChannelMask: (1 << e.doc.document.Channels()) - 1}
	} else if selection.Start == selection.End && p.Operation != protocol.OperationCrossfade && p.Operation != protocol.OperationGenerate {
		selection.Start, selection.End = 0, e.doc.document.Frames()
	}
	builder, err := e.prepareProcess(p, selection, audio)
	if err != nil {
		return protocol.ProcessJobResult{}, fmt.Errorf("%s: prepare processing: %w", method, err)
	}
	reservation, err := e.reserveProcess(method, builder.MaterializedBytes())
	if err != nil {
		builder.Cancel()
		return protocol.ProcessJobResult{}, err
	}
	before := cloneEditor(e.doc.editor)
	before.selection = p.SelectionRange
	phase, phaseCount, gainResolved, gainDB := protocol.PhaseProcessing, 1, true, p.GainDB
	var target *float64
	if p.Operation == protocol.OperationNormalizePeak || p.Operation == protocol.OperationNormalizeLoudness {
		phase, phaseCount, gainResolved, gainDB = protocol.PhaseAnalyzing, 2, false, 0
		if p.Operation == protocol.OperationNormalizeLoudness {
			phaseCount = 3
		}
		value := *p.Target
		target = &value
	}
	e.jobs.processSequence++
	e.jobs.processJob = &processingJob{
		reservedBytes: reservation,
		result: protocol.ProcessJobResult{
			SelectionResult: protocol.SelectionResult{DocumentID: p.DocumentID, SelectionRange: selection},
			JobID:           fmt.Sprintf("process-%d", e.jobs.processSequence), State: protocol.JobRunning, Operation: p.Operation,
			GainDB: gainDB, TotalFrames: selection.End - selection.Start,
			Phase: phase, PhaseCount: phaseCount, GainResolved: gainResolved, Target: target,
		},
		builder: builder, before: historySnapshot{document: e.doc.document, editor: before},
		historyState: e.historyState.history.CurrentID(),
	}
	e.refreshProcessStatus(e.jobs.processJob)
	if provider, ok := builder.(interface{ Progress() processing.Progress }); ok {
		progress := provider.Progress()
		e.jobs.processJob.result.ProcessedFrames, e.jobs.processJob.result.TotalFrames = progress.FramesDone, progress.FramesTotal
	}
	return e.jobs.processJob.result, nil
}

func validateProcessParameters(p protocol.ProcessStartParams) error {
	const method = protocol.MethodProcessStart
	if p.Operation == protocol.OperationGain {
		if p.Target != nil || math.IsNaN(p.GainDB) || math.IsInf(p.GainDB, 0) || p.GainDB < -120 || p.GainDB > 60 {
			return fmt.Errorf("%s: gain requires finite dB in [-120, 60] and no target", method)
		}
		return nil
	}
	minimum := -120.0
	switch p.Operation {
	case protocol.OperationNormalizePeak:
	case protocol.OperationNormalizeLoudness:
		minimum = -69
	case protocol.OperationSpectralAttenuate:
		if p.Target != nil || math.IsNaN(p.GainDB) || math.IsInf(p.GainDB, 0) || p.GainDB < -120 || p.GainDB > 0 {
			return fmt.Errorf("%s: attenuation must be in [-120,0] dB", method)
		}
		return nil
	case protocol.OperationSpectralRemove, protocol.OperationSpectralHeal, protocol.OperationNoiseReduce, protocol.OperationRemoveClicks, protocol.OperationDeclip, protocol.OperationTimeStretch, protocol.OperationRemoveHum, protocol.OperationFadeIn, protocol.OperationFadeOut, protocol.OperationCrossfade, protocol.OperationReverse, protocol.OperationInvert, protocol.OperationRemoveDC, protocol.OperationMonoToStereo, protocol.OperationStereoToMono, protocol.OperationExtractChannel, protocol.OperationResample, protocol.OperationGenerate:
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

func (e *Engine) prepareProcess(p protocol.ProcessStartParams, selection protocol.SelectionRange, audio []float32) (processing.Stepper, error) {
	selected := ops.Range{Start: selection.Start, End: selection.End, ChannelMask: selection.ChannelMask}
	limits := processing.Limits{MaxOutputBytes: e.processStorageLimit()}
	if p.Operation == protocol.OperationGain {
		return processing.NewBuilder(e.doc.document, selected, processing.Gain{DB: p.GainDB}, limits)
	}
	if p.Operation == protocol.OperationNormalizePeak || p.Operation == protocol.OperationNormalizeLoudness {
		return processing.NewNormalizer(e.doc.document, selected, p.Operation, *p.Target, limits)
	}
	if p.Seed > math.MaxUint32 {
		return nil, fmt.Errorf("noise seed must be uint32")
	}
	if p.Operation == protocol.OperationResample && (p.SampleRate < MinSampleRate || p.SampleRate > MaxSampleRate) {
		return nil, fmt.Errorf("sample rate must be in [%d, %d]", MinSampleRate, MaxSampleRate)
	}
	if p.Operation == protocol.OperationMonoToStereo || p.Operation == protocol.OperationStereoToMono || p.Operation == protocol.OperationResample {
		selected = ops.Range{Start: p.Start, End: p.End, ChannelMask: p.ChannelMask}
	}
	restorationSettings, err := e.prepareRestorationSettings(p, selected)
	if err != nil {
		return nil, err
	}
	return processing.NewOperation(e.doc.document, selected, processing.Settings{
		Operation: p.Operation, Curve: p.Curve, DurationFrames: p.DurationFrames, Restoration: restorationSettings,
		ChannelMode: p.ChannelMode, Channel: p.Channel, SampleRate: p.SampleRate, Quality: p.Quality,
		Generator: p.Generator, Frequency: p.Frequency, EndFrequency: p.EndFrequency, LevelDB: p.LevelDB, Seed: p.Seed,
		Audio: audio, AudioRate: p.SourceSampleRate,
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
	format := protocol.ProcessCandidate{SampleRate: e.doc.document.SampleRate(), Channels: e.doc.document.Channels(), Frames: e.doc.document.Frames(), SelectionRange: job.result.SelectionRange}
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
	if e.historyState.history == nil || e.historyState.history.CurrentID() != job.historyState {
		return fmt.Errorf("%s: processing source history changed", method)
	}
	return nil
}

func (e *Engine) activeProcess(method string, p protocol.ProcessJobParams) (*processingJob, error) {
	if err := e.validateDocumentID(method, p.DocumentID); err != nil {
		return nil, err
	}
	job := e.jobs.processJob
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
	result := e.jobs.cancelledProcess
	if result != nil && result.JobID == p.JobID && result.DocumentID == p.DocumentID && e.doc.editor.documentID == p.DocumentID {
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
	if job.result.State == protocol.JobReady {
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
		job.candidate, job.result.State = candidate, protocol.JobReady
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
	if job := e.jobs.processJob; job != nil {
		phase = job.result.PhaseIndex
	}
	var result protocol.ProcessJobResult
	for range maxProcessBatchSteps {
		var err error
		result, err = e.stepProcess(p)
		if err != nil {
			return protocol.ProcessJobResult{}, fmt.Errorf("%s: %w", protocol.MethodProcessStepBatch, err)
		}
		if result.State != protocol.JobRunning || result.PhaseIndex != phase {
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
	if e.playback.transport != nil && e.playback.transport.previewJobID == job.result.JobID {
		e.playback.transport, e.playback.source = nil, sourceStopped
	}
	e.jobs.processJob = nil
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
	result.State = protocol.JobCancelled
	e.discardProcess(job)
	e.jobs.cancelledProcess = &result
	return result, nil
}

func (e *Engine) commitProcess(p protocol.ProcessJobParams) (protocol.EditResult, error) {
	const method = protocol.MethodProcessCommit
	job, err := e.activeProcess(method, p)
	if err != nil {
		return protocol.EditResult{}, err
	}
	if job.result.State != protocol.JobReady {
		return protocol.EditResult{}, fmt.Errorf("%s: processing job is not ready", method)
	}
	if job.result.Operation == protocol.OperationExtractChannel {
		return protocol.EditResult{}, fmt.Errorf("%s: extraction must be opened in another window", method)
	}
	if job.identity {
		e.discardProcess(job)
		return e.editResult(false), nil
	}
	if e.doc.documentSequence == math.MaxUint64 {
		return protocol.EditResult{}, fmt.Errorf("%s: document identity exhausted", method)
	}
	editor := cloneEditor(e.doc.editor)
	editor.selection = job.result.SelectionRange
	if job.result.Candidate != nil && job.result.Operation != protocol.OperationGain && job.result.Operation != protocol.OperationNormalizePeak && job.result.Operation != protocol.OperationNormalizeLoudness {
		editor.selection = job.result.Candidate.SelectionRange
	}
	label := "Gain"
	switch job.result.Operation {
	case protocol.OperationNormalizePeak:
		label = "Normalize peak"
	case protocol.OperationNormalizeLoudness:
		label = "Normalize loudness"
	case protocol.OperationEffects:
		label = "Effects"
	default:
		if job.result.Operation != protocol.OperationGain {
			label = editHistoryLabel(job.result.Operation)
		}
	}
	staged, err := e.historyState.history.StagePush(label, job.before, historySnapshot{document: job.candidate, editor: editor})
	if err != nil {
		return protocol.EditResult{}, fmt.Errorf("%s: retain undo history: %w", method, err)
	}
	e.doc.document, e.historyState.history = job.candidate, staged
	e.doc.documentSequence++
	editor.documentID = fmt.Sprintf("doc-%d", e.doc.documentSequence)
	e.doc.editor = editor
	e.playback.transport, e.playback.source = nil, sourceStopped
	e.jobs.processJob = nil
	return e.editResult(true), nil
}

// decodeProcessAudio copies the audio generator's little-endian float32 PCM
// out of the call input, which the engine does not retain. Every other
// operation must come without binary input or a source rate.
func decodeProcessAudio(p protocol.ProcessStartParams, input []byte) ([]float32, error) {
	if p.Operation != protocol.OperationGenerate || p.Generator != protocol.GeneratorAudio {
		if len(input) > 0 || p.SourceSampleRate != 0 {
			return nil, fmt.Errorf("binary input and sourceSampleRate need the audio generator")
		}
		return nil, nil
	}
	if len(input) == 0 || len(input)%4 != 0 {
		return nil, fmt.Errorf("audio generator needs mono float32 PCM as binary input")
	}
	audio := make([]float32, len(input)/4)
	for i := range audio {
		audio[i] = math.Float32frombits(binary.LittleEndian.Uint32(input[4*i:]))
	}
	return audio, nil
}
