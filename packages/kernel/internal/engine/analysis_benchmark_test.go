package engine

import (
	"encoding/json"
	"math"
	"os"
	"testing"
	"time"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

// Opt-in and serial: this processes every frame/hop of a one-hour repeated
// program while sharing immutable source storage. It is not a codec import or
// a browser-worker benchmark. Counts cover actual Engine.Call JSON requests.
//
// Native: just bench-analysis-hour
//
// V8/WASM: just bench-analysis-hour-wasm (clean, matching Go toolchain runner).
//
// With just --command go test, append /statistics/budgeted to the benchmark
// regex to select one case. Pitch
// is substantially more expensive and separately enabled with
// AAE_ANALYSIS_HOUR_PITCH=1 (also pass it inside the clean WASM runner).
func BenchmarkAnalysisOneHour(b *testing.B) {
	if os.Getenv("AAE_ANALYSIS_HOUR_BENCHMARK") != "1" {
		b.Skip("set AAE_ANALYSIS_HOUR_BENCHMARK=1 for the serial one-hour analysis measurement")
	}
	kinds := []string{"statistics", "clipping", "spectrum", "spectrogram"}
	if os.Getenv("AAE_ANALYSIS_HOUR_PITCH") == "1" {
		kinds = append(kinds, "pitch")
	}
	for _, kind := range kinds {
		b.Run(kind, func(b *testing.B) {
			for _, mode := range []string{"reference", "budgeted"} {
				b.Run(mode, func(b *testing.B) { benchmarkAnalysisHour(b, kind, mode) })
			}
		})
	}
}

func analysisHourEngine(b *testing.B) *Engine {
	b.Helper()
	const frames, rate, blockFrames = int64(48000 * 3600), 48000, 16384
	channels := make([]audiobuf.Channel, 2)
	for c := range channels {
		samples := make([]float32, blockFrames)
		for i := range samples {
			// Coherent but varied tones keep LUFS available and avoid a
			// pathological clip-marker count dominating the throughput test.
			x := 2 * math.Pi * float64(i) / blockFrames
			samples[i] = float32(.3*math.Sin(x*float64(149+c*71)) + .08*math.Cos(x*37))
		}
		full, err := audiobuf.NewBlock(samples)
		if err != nil {
			b.Fatal(err)
		}
		blocks := make([]*audiobuf.Block, int((frames+blockFrames-1)/blockFrames))
		for i := range blocks {
			blocks[i] = full
		}
		if tail := int(frames % blockFrames); tail != 0 {
			blocks[len(blocks)-1], err = audiobuf.NewBlock(samples[:tail])
			if err != nil {
				b.Fatal(err)
			}
		}
		channels[c], err = audiobuf.NewChannelFromBlocks(blocks)
		if err != nil {
			b.Fatal(err)
		}
	}
	document, err := audiobuf.NewDocument(channels, rate, audiobuf.Metadata{Name: "one-hour-repeated-program.wav"})
	if err != nil {
		b.Fatal(err)
	}
	e := New()
	e.doc.document = document
	e.doc.documentSequence = 1
	e.doc.sourceBitDepth, e.doc.sourceFloat = 32, true
	e.doc.editor = editorState{documentID: "doc-1", selection: protocol.SelectionRange{ChannelMask: 3}}
	e.historyState.history, err = newDocumentHistory(document, e.doc.editor)
	if err != nil {
		b.Fatal(err)
	}
	return e
}

func benchmarkAnalysisHour(b *testing.B, kind, mode string) {
	e := analysisHourEngine(b)
	p := analysisParams(e, kind, 0, e.doc.document.Frames(), 3)
	p.FFTSize, p.Averaging, p.Window = 2048, 64, "hann"
	p.Width, p.Height, p.Channel, p.MinDB = 128, 160, 0, -100
	startPayload, err := json.Marshal(p)
	if err != nil {
		b.Fatal(err)
	}
	decode := func(response []byte) protocol.AnalysisJobResult {
		var envelope struct {
			OK     bool                       `json:"ok"`
			Error  string                     `json:"error"`
			Result protocol.AnalysisJobResult `json:"result"`
		}
		if err := json.Unmarshal(response, &envelope); err != nil {
			b.Fatal(err)
		}
		if !envelope.OK {
			b.Fatal(envelope.Error)
		}
		return envelope.Result
	}
	var calls int64
	var totalStep, maxStep time.Duration
	b.ResetTimer()
	for range b.N {
		r := decode(e.Call(protocol.MethodAnalysisStart, startPayload))
		if mode == "reference" {
			e.analysis.analysisJob.now = analysisTestClock(analysisStepBudget)
		}
		include := false
		params := protocol.AnalysisJobParams{DocumentID: r.DocumentID, JobID: r.JobID, IncludeData: &include}
		payload, err := json.Marshal(params)
		if err != nil {
			b.Fatal(err)
		}
		for r.State != "ready" {
			start := time.Now()
			response := e.Call(protocol.MethodAnalysisStep, payload)
			elapsed := time.Since(start)
			totalStep += elapsed
			maxStep = max(maxStep, elapsed)
			calls++
			r = decode(response)
			_ = e.TakeData()
		}
		if r.ProcessedFrames != e.doc.document.Frames() {
			b.Fatal("incomplete analysis", r)
		}
		// Clipping reserves its ready result, and spectrogram caching would
		// otherwise turn the second iteration into a zero-work measurement.
		var cancel protocol.Response
		if err := json.Unmarshal(e.Call(protocol.MethodAnalysisCancel, payload), &cancel); err != nil || !cancel.OK {
			b.Fatal("cancel failed", err, cancel.Error)
		}
		e.analysis.analysisCache = nil
	}
	b.StopTimer()
	b.ReportMetric(float64(calls)/float64(b.N), "step-calls/op")
	b.ReportMetric(2, "control-calls/op")
	b.ReportMetric(float64(maxStep)/float64(time.Millisecond), "max-step-ms")
	if calls > 0 {
		b.ReportMetric(float64(totalStep)/float64(calls)/float64(time.Millisecond), "mean-step-ms")
	}
}
