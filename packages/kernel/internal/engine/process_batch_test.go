package engine

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	processing "github.com/cwbudde/algo-audio-editor/packages/kernel/internal/process"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

type batchObservedStepper struct {
	processing.Stepper
	calls int
	after func(int)
}

func (s *batchObservedStepper) Step(ctx context.Context) (processing.Progress, error) {
	s.calls++
	progress, err := s.Stepper.Step(ctx)
	if s.after != nil {
		s.after(s.calls)
	}
	return progress, err
}

func batchBlockEngine(t *testing.T) *Engine {
	t.Helper()
	input := make([]float32, audiobuf.BlockFrames)
	for i := range input {
		input[i] = .25
	}
	block, err := audiobuf.NewBlock(input)
	if err != nil {
		t.Fatal(err)
	}
	channel, err := audiobuf.NewChannelFromBlocks([]*audiobuf.Block{block, block, block, block, block, block})
	if err != nil {
		t.Fatal(err)
	}
	channel = channel.Concat(audiobuf.NewChannel([]float32{.25, -.5, math.Float32frombits(0x80000000)}))
	document, err := audiobuf.NewDocument([]audiobuf.Channel{channel}, 48000, audiobuf.Metadata{Name: "batch.wav"})
	if err != nil {
		t.Fatal(err)
	}
	return processEngineWithDocument(t, document)
}

func TestProcessBatchHasFourStepBoundAndPreservesSingleStep(t *testing.T) {
	if maxProcessBatchSteps != 4 {
		t.Fatal("worker cancellation/yield contract requires a four-step bound")
	}
	e := batchBlockEngine(t)
	before := e.editResult(false)
	result := startEngineProcess(t, e, processParams(e, 0, e.document.Frames(), 1, 0))
	observed := &batchObservedStepper{Stepper: e.processJob.builder}
	e.processJob.builder = observed
	result, err := e.stepProcessBatch(jobParams(result))
	if err != nil || observed.calls != maxProcessBatchSteps || result.ProcessedFrames != maxProcessBatchSteps*audiobuf.BlockFrames || result.State != "running" {
		t.Fatal("batch exceeded or failed its fixed bound", observed.calls, result, err)
	}
	result, err = e.stepProcess(jobParams(result))
	if err != nil || observed.calls != maxProcessBatchSteps+1 || result.ProcessedFrames != (maxProcessBatchSteps+1)*audiobuf.BlockFrames {
		t.Fatal("default process.step no longer delegates exactly one step", err)
	}
	result, err = e.stepProcessBatch(jobParams(result))
	if err != nil || result.State != "ready" || result.ProcessedFrames != result.TotalFrames || observed.calls != 7 {
		t.Fatal("batch did not stop at its terminal inner step", observed.calls, result, err)
	}
	if !reflect.DeepEqual(before, e.editResult(false)) {
		t.Fatal("batched private identity changed committed state")
	}
	if reply, err := e.stepProcessBatch(jobParams(result)); err != nil || !reflect.DeepEqual(reply, result) || observed.calls != 7 {
		t.Fatal("ready repeat stepped a released builder", err)
	}
	if reply, err := e.commitProcess(jobParams(result)); err != nil || reply.Changed || !reflect.DeepEqual(before, e.editResult(false)) {
		t.Fatal("batched identity published an edit", err)
	}
}

func TestProcessBatchStopsAtEveryNormalizationPhaseBoundary(t *testing.T) {
	input := make([]float32, audiobuf.BlockFrames+17)
	for i := range input {
		input[i] = float32(i%31-15) / 128
	}
	for _, operation := range []string{"normalize-peak", "normalize-loudness"} {
		t.Run(operation, func(t *testing.T) {
			e, _ := openEditorFixture(t, input, 1)
			before, memory := e.editResult(false), e.documentMemory()
			result := startEngineProcess(t, e, normalizationParams(e, 0, int64(len(input)), 1, operation, -23))
			result, err := e.stepProcessBatch(jobParams(result))
			if err != nil || result.Phase != "processing" || result.PhaseIndex != 1 || result.ProcessedFrames != 0 || result.Peak != 0 || result.State != "running" || e.documentMemory() != memory {
				t.Fatal("batch crossed analysis boundary into output rendering", result, err)
			}
			result, err = e.stepProcessBatch(jobParams(result))
			if err != nil {
				t.Fatal(err)
			}
			if operation == "normalize-loudness" {
				if result.Phase != "verifying" || result.PhaseIndex != 2 || result.ProcessedFrames != 0 || result.State != "running" || result.OutputLUFS != nil {
					t.Fatal("batch crossed processing boundary into verification", result)
				}
				result, err = e.stepProcessBatch(jobParams(result))
				if err != nil || result.OutputLUFS == nil || math.Abs(*result.OutputLUFS+23) > .01 {
					t.Fatal("batch did not finish actual float32 verification", result, err)
				}
			}
			if result.State != "ready" || !reflect.DeepEqual(before, e.editResult(false)) {
				t.Fatal("phase-boundary batch did not preserve private source")
			}
			assertEditBits(t, editSamples(t, e), input)
			if _, err := e.cancelProcess(jobParams(result)); err != nil || e.documentMemory() != memory {
				t.Fatal("batched normalization could not release its candidate", err)
			}
		})
	}
}

func TestProcessBatchMatchesIndividualStepsExactResultAndOutput(t *testing.T) {
	const frames = audiobuf.BlockFrames + 37
	input := make([]float32, frames*2)
	for frame := range frames {
		input[frame*2] = float32(frame%31-15) / 128
		input[frame*2+1] = float32(frame%17-8) / 64
	}
	input[0] = math.Float32frombits(0x80000000)
	for _, operation := range []string{"gain", "normalize-peak", "normalize-loudness"} {
		t.Run(operation, func(t *testing.T) {
			individual, _ := openEditorFixture(t, input, 2)
			batched, _ := openEditorFixture(t, input, 2)
			results := make([]protocol.ProcessJobResult, 2)
			for index, e := range []*Engine{individual, batched} {
				params := processParams(e, 0, frames, 3, 6)
				if operation != "gain" {
					params = normalizationParams(e, 0, frames, 3, operation, -23)
				}
				result := startEngineProcess(t, e, params)
				for attempts := 0; result.State == "running" && attempts < 1000; attempts++ {
					var err error
					if index == 0 {
						result, err = e.stepProcess(jobParams(result))
					} else {
						result, err = e.stepProcessBatch(jobParams(result))
					}
					if err != nil {
						t.Fatal(err)
					}
				}
				if result.State != "ready" {
					t.Fatal("bounded test job did not finish")
				}
				results[index] = result
				assertEditBits(t, editSamples(t, e), input)
			}
			if !reflect.DeepEqual(results[0], results[1]) {
				t.Fatal("batch changed exact peak/LUFS/planning/identity telemetry", results)
			}
			var committed protocol.EditResult
			for index, e := range []*Engine{individual, batched} {
				reply, err := e.commitProcess(jobParams(results[index]))
				if err != nil {
					t.Fatal(err)
				}
				if index == 0 {
					committed = reply
				} else if !reflect.DeepEqual(reply, committed) {
					t.Fatal("batch changed atomic publication/history/selection")
				}
			}
			assertEditBits(t, editSamples(t, batched), editSamples(t, individual))
		})
	}
}

func TestProcessBatchCancelledTombstoneDoesNotStepNewJob(t *testing.T) {
	e, _ := openEditorFixture(t, []float32{.5, -.25}, 1)
	first := startEngineProcess(t, e, processParams(e, 0, 2, 1, 6))
	cancelled, err := e.cancelProcess(jobParams(first))
	if err != nil {
		t.Fatal(err)
	}
	if result, err := e.stepProcessBatch(jobParams(first)); err != nil || !reflect.DeepEqual(result, cancelled) || e.processJob != nil {
		t.Fatal("cancelled batch dereferenced or resurrected a builder", err)
	}
	second := startEngineProcess(t, e, processParams(e, 0, 2, 1, 0))
	current := e.processJob
	if result, err := e.stepProcessBatch(jobParams(first)); err != nil || !reflect.DeepEqual(result, cancelled) || e.processJob != current || current.result.ProcessedFrames != 0 {
		t.Fatal("old cancelled batch stepped a newer active job", err)
	}
	for _, params := range []protocol.ProcessJobParams{{DocumentID: second.DocumentID}, {DocumentID: "stale", JobID: second.JobID}, {DocumentID: second.DocumentID, JobID: "stale"}} {
		if _, err := e.stepProcessBatch(params); err == nil || e.processJob != current || current.result.ProcessedFrames != 0 {
			t.Fatal("invalid batch identity altered newer work", err)
		}
	}
}

type batchFailingProcess struct {
	calls   *int
	failure error
	failAt  int
}

func (p batchFailingProcess) NewChannel(int, int, int64) (processing.Processor, error) {
	return batchFailingProcessor{process: p}, nil
}

type batchFailingProcessor struct{ process batchFailingProcess }

func (p batchFailingProcessor) ProcessBlock([]float64) error {
	*p.process.calls++
	if *p.process.calls == p.process.failAt {
		return p.process.failure
	}
	return nil
}

func TestProcessBatchInnerProcessorFailureReleasesPartialOutput(t *testing.T) {
	for _, failAt := range []int{2, 3} {
		e := batchBlockEngine(t)
		if _, err := e.configure(protocol.EngineConfigureParams{SampleRate: 48000, Channels: 1}); err != nil {
			t.Fatal(err)
		}
		if _, err := e.playDocument(protocol.TransportPlayParams{}); err != nil {
			t.Fatal(err)
		}
		before, memory, transport := e.editResult(false), e.documentMemory(), e.transport
		result := startEngineProcess(t, e, processParams(e, 0, e.document.Frames(), 1, 6))
		calls := 0
		sentinel := errors.New("delayed inner processor failure")
		builder, err := processing.NewBuilder(e.document, ops.Range{End: e.document.Frames(), ChannelMask: 1}, batchFailingProcess{calls: &calls, failure: sentinel, failAt: failAt}, processing.Limits{})
		if err != nil {
			t.Fatal(err)
		}
		e.processJob.builder.Cancel()
		e.processJob.builder = builder
		if _, err := e.stepProcessBatch(jobParams(result)); !errors.Is(err, sentinel) || !strings.Contains(err.Error(), protocol.MethodProcessStepBatch) || calls != failAt {
			t.Fatal("batch did not stop on its failing inner processor", calls, err)
		}
		if e.processJob != nil || e.documentMemory() != memory || e.transport != transport || !transport.playing || !reflect.DeepEqual(before, e.editResult(false)) {
			t.Fatal("inner batch failure retained output or changed committed source/history/playback")
		}
		if _, err := builder.MemoryDocument(); err == nil {
			t.Fatal("failed batch builder retained partial output")
		}
	}
}

func TestProcessBatchValidatesSourceBeforeEveryInnerStep(t *testing.T) {
	e := batchBlockEngine(t)
	before, memory := e.editResult(false), e.documentMemory()
	result := startEngineProcess(t, e, processParams(e, 0, e.document.Frames(), 1, 6))
	job := e.processJob
	observed := &batchObservedStepper{Stepper: job.builder, after: func(int) { job.historyState = "stale" }}
	job.builder = observed
	if _, err := e.stepProcessBatch(jobParams(result)); err == nil || observed.calls != 1 || e.processJob != job || !reflect.DeepEqual(before, e.editResult(false)) {
		t.Fatal("batch failed to revalidate source before its second step", err)
	}
	if e.documentMemory().SampleBytes <= memory.SampleBytes {
		t.Fatal("first successful private step was not accounted before validation failure")
	}
	if _, err := e.cancelProcess(jobParams(result)); err != nil || e.documentMemory() != memory {
		t.Fatal("source-invalidated batch could not release retained private work", err)
	}
}

func TestProcessBatchRPCDispatchAndSilentNoop(t *testing.T) {
	e, _ := openEditorFixture(t, make([]float32, 19200), 1)
	e.editor.selection = protocol.SelectionRange{Start: 17, End: 17, ChannelMask: 1}
	before := e.editResult(false)
	result := startEngineProcess(t, e, normalizationParams(e, 17, 17, 1, "normalize-loudness", -23))
	response := editorCall(t, e, protocol.MethodProcessStepBatch, jobParams(result))
	if !response.OK || json.Unmarshal(response.Result, &result) != nil || result.State != "ready" || result.PhaseIndex != 2 || result.UnchangedReason != "silent" {
		t.Fatal("batch RPC failed bounded silent terminal path", string(response.Result), response.Error)
	}
	if reply, err := e.commitProcess(jobParams(result)); err != nil || reply.Changed || !reflect.DeepEqual(before, e.editResult(false)) {
		t.Fatal("batched silent commit changed exact source/editor/history", err)
	}
	if response := editorCall(t, e, protocol.MethodProcessStepBatch, nil); response.OK {
		t.Fatal("batch accepted missing request identities")
	}
}
