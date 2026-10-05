package engine

import (
	"bytes"
	"errors"
	"math"
	"reflect"
	"testing"
	"time"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func TestAnalysisBudgetDeadlineProgressCompletionAndErrors(t *testing.T) {
	sentinel := errors.New("unit failure")
	for _, tc := range []struct {
		name             string
		tick             time.Duration
		done, fail, want int
	}{
		{"one unit at deadline", analysisStepBudget, 0, 0, 1},
		{"multiple units", analysisStepBudget / 4, 0, 0, 4},
		{"expired still advances", analysisStepBudget * 2, 0, 0, 1},
		{"completion stops", analysisStepBudget / 4, 2, 0, 2},
		{"error stops", analysisStepBudget / 4, 0, 2, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			err := runAnalysisBudget(analysisTestClock(tc.tick), func() (bool, error) {
				calls++
				if calls == tc.fail {
					return false, sentinel
				}
				return calls == tc.done, nil
			})
			if calls != tc.want || (tc.fail != 0 && !errors.Is(err, sentinel)) || (tc.fail == 0 && err != nil) {
				t.Fatal(calls, err)
			}
		})
	}
}

func TestAnalysisBatchExactResultsAcrossSchedules(t *testing.T) {
	const frames = 24000 // Long enough to include integrated loudness finishing.
	input := make([]float32, frames*2)
	for i := range frames {
		input[2*i] = float32(.4 * math.Sin(2*math.Pi*440*float64(i)/48000))
		input[2*i+1] = float32(.2 * math.Sin(2*math.Pi*660*float64(i)/48000))
	}
	input[2046], input[2048], input[2050] = 1.2, 1.2, 1.2
	for _, kind := range []string{"statistics", "clipping", "pitch", "spectrum", "spectrogram"} {
		t.Run(kind, func(t *testing.T) {
			var want protocol.AnalysisJobResult
			var wantData []byte
			var wantCalls int
			for schedule, tick := range []time.Duration{analysisStepBudget, analysisStepBudget / 16} {
				e, _ := openEditorFixture(t, input, 2)
				p := analysisParams(e, kind, 0, frames, 3)
				p.FFTSize, p.Averaging, p.HopSize = 256, 8, 800
				p.Width, p.Height, p.Channel, p.MinDB = 4, 16, 1, -100
				r, err := e.startAnalysis(p)
				if err != nil {
					t.Fatal(err)
				}
				e.analysis.analysisJob.now = analysisTestClock(tick)
				calls := 0
				for r.State != "ready" {
					if calls >= 50000 {
						t.Fatal("job stalled")
					}
					previous := r.ProcessedFrames
					value, err := e.dispatchAnalysis(protocol.MethodAnalysisStep, []byte(mustJSON(t, protocol.AnalysisJobParams{DocumentID: r.DocumentID, JobID: r.JobID})))
					if err != nil {
						t.Fatal(err)
					}
					r = value.(protocol.AnalysisJobResult)
					if r.ProcessedFrames < previous {
						t.Fatal("progress regressed")
					}
					_ = e.TakeData()
					calls++
				}
				data := append([]byte(nil), e.analysis.analysisJob.data...)
				if kind == "statistics" && r.IntegratedLUFS == nil {
					t.Fatal("comparison omitted loudness finishing")
				}
				if kind == "clipping" && !reflect.DeepEqual(e.analysis.analysisJob.clipRuns, []clippedRun{{start: 1023, end: 1026}}) {
					t.Fatal("clipping boundaries changed", e.analysis.analysisJob.clipRuns)
				}
				if schedule == 0 {
					want, wantData, wantCalls = r, data, calls
				} else if !reflect.DeepEqual(r, want) || !bytes.Equal(data, wantData) || calls >= wantCalls {
					t.Fatalf("schedule changed result or failed to batch: calls %d/%d, got %+v want %+v", calls, wantCalls, r, want)
				}
				if !reflect.DeepEqual(input, editSamples(t, e)) {
					t.Fatal("analysis modified source")
				}
			}
		})
	}
}

func TestAnalysisBatchTileDataPolicyAndCache(t *testing.T) {
	e, _ := openEditorFixture(t, make([]float32, 8192), 1)
	p := analysisParams(e, "spectrogram", 0, 8192, 1)
	p.FFTSize, p.Width, p.Height, p.MinDB = 256, 4, 16, -100
	r, err := e.startAnalysis(p)
	if err != nil {
		t.Fatal(err)
	}
	e.analysis.analysisJob.now = analysisTestClock(analysisStepBudget / 8)
	include := false
	params := protocol.AnalysisJobParams{DocumentID: r.DocumentID, JobID: r.JobID, IncludeData: &include}
	for r.CompletedColumns == 0 {
		value, err := e.dispatchAnalysis(protocol.MethodAnalysisStep, []byte(mustJSON(t, params)))
		if err != nil {
			t.Fatal(err)
		}
		r = value.(protocol.AnalysisJobResult)
		if r.DataBytes != 0 || e.TakeData() != nil {
			t.Fatal("suppressed tile emitted")
		}
	}
	include = true
	value, err := e.dispatchAnalysis(protocol.MethodAnalysisStep, []byte(mustJSON(t, params)))
	if err != nil {
		t.Fatal(err)
	}
	r = value.(protocol.AnalysisJobResult)
	if r.State != "running" || r.DataBytes != 4*16*4 || len(e.TakeData()) != r.DataBytes {
		t.Fatal("partial tile missing", r)
	}
	include = false
	var data []byte
	for r.State != "ready" {
		value, err := e.dispatchAnalysis(protocol.MethodAnalysisStep, []byte(mustJSON(t, params)))
		if err != nil {
			t.Fatal(err)
		}
		r = value.(protocol.AnalysisJobResult)
		data = e.TakeData()
		if r.State == "running" && (r.DataBytes != 0 || data != nil) {
			t.Fatal("suppressed tile emitted")
		}
	}
	if r.State != "ready" || len(data) != 4*16*4 {
		t.Fatal("ready tile missing")
	}
	cached, err := e.startAnalysis(p)
	if err != nil || cached.State != "ready" || !bytes.Equal(data, e.TakeData()) {
		t.Fatal("cache changed", err)
	}
}

func TestAnalysisBatchCancellationAndFailureReleasePrivateWork(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "cancel", true: "nonfinite"}[fail], func(t *testing.T) {
			input := make([]float32, 32768)
			if fail {
				input[2048] = float32(math.NaN())
			}
			e, _ := openEditorFixture(t, input, 1)
			r, err := e.startAnalysis(analysisParams(e, "statistics", 0, 32768, 1))
			if err != nil {
				t.Fatal(err)
			}
			e.analysis.analysisJob.now = analysisTestClock(analysisStepBudget / 4)
			params := protocol.AnalysisJobParams{DocumentID: r.DocumentID, JobID: r.JobID}
			value, err := e.dispatchAnalysis(protocol.MethodAnalysisStep, []byte(mustJSON(t, params)))
			if fail {
				if err == nil || e.analysis.analysisJob != nil {
					t.Fatal("batch failure retained work", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			progress := value.(protocol.AnalysisJobResult)
			if progress.ProcessedFrames != 4096 || progress.State != "running" {
				t.Fatal("batch did not stop", progress)
			}
			for range 2 {
				value, err = e.dispatchAnalysis(protocol.MethodAnalysisCancel, []byte(mustJSON(t, params)))
				if err != nil || value.(protocol.AnalysisJobResult).State != "cancelled" || e.analysis.analysisJob != nil {
					t.Fatal("cancel failed", err)
				}
			}
			if _, err = e.dispatchAnalysis(protocol.MethodAnalysisStep, []byte(mustJSON(t, params))); err == nil {
				t.Fatal("cancelled batch resumed")
			}
		})
	}
}

func TestPlaybackSpectrumBatchExactAcrossSchedules(t *testing.T) {
	var want []byte
	for schedule, tick := range []time.Duration{analysisStepBudget, analysisStepBudget / 8} {
		s, err := newSpectrumAnalysis(48000, 2, 256, "hann", 1, 6)
		if err != nil {
			t.Fatal(err)
		}
		j := &playbackSpectrumJob{spectrum: s, source: make([]float32, playbackSpectrumFrames*2), write: 256, count: 256, data: make([]byte, 2*129*16), result: protocol.AnalysisSpectrumResult{State: "running", Channels: 2}}
		for i := range 256 {
			j.source[i*2] = float32(.4 * math.Sin(float64(i)))
			j.source[i*2+1] = float32(.2 * math.Cos(float64(i)))
		}
		calls := 0
		clock := analysisTestClock(tick)
		for j.result.State != "ready" {
			if err := runAnalysisBudget(clock, j.stepUnit); err != nil {
				t.Fatal(err)
			}
			calls++
		}
		if schedule == 0 {
			if calls != 4 {
				t.Fatal("one-unit clock did not yield", calls)
			}
			want = append([]byte(nil), j.data...)
		} else if calls != 1 || !bytes.Equal(want, j.data) {
			t.Fatal("live batch changed output", calls)
		}
	}
}
