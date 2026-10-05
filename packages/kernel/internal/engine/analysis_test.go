package engine

import (
	"encoding/binary"
	"encoding/json"
	"math"
	"reflect"
	"testing"
	"time"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func analysisTestClock(tick time.Duration) func() time.Time {
	clock := time.Unix(0, 0)
	return func() time.Time {
		result := clock
		clock = clock.Add(tick)
		return result
	}
}

func finishAnalysis(t *testing.T, e *Engine, r protocol.AnalysisJobResult) (protocol.AnalysisJobResult, []byte) {
	t.Helper()
	for steps := 0; steps < 200000 && r.State != "ready"; steps++ {
		value, err := e.dispatchAnalysis(protocol.MethodAnalysisStep, []byte(mustJSON(t, protocol.AnalysisJobParams{DocumentID: r.DocumentID, JobID: r.JobID})))
		if err != nil {
			t.Fatal(err)
		}
		r = value.(protocol.AnalysisJobResult)
		_ = e.TakeData()
	}
	if r.State != "ready" {
		t.Fatal("analysis did not finish", r)
	}
	value, err := e.dispatchAnalysis(protocol.MethodAnalysisStep, []byte(mustJSON(t, protocol.AnalysisJobParams{DocumentID: r.DocumentID, JobID: r.JobID})))
	if err != nil {
		t.Fatal(err)
	}
	return value.(protocol.AnalysisJobResult), e.TakeData()
}

func analysisParams(e *Engine, kind string, start, end int64, mask int) protocol.AnalysisStartParams {
	return protocol.AnalysisStartParams{SelectionResult: protocol.SelectionResult{DocumentID: e.doc.editor.documentID, SelectionRange: protocol.SelectionRange{Start: start, End: end, ChannelMask: mask}}, Kind: protocol.AnalysisKind(kind)}
}

func TestAnalysisStatisticsSelectionFiniteOwnershipAndCancellation(t *testing.T) {
	input := []float32{float32(math.NaN()), float32(math.NaN()), 0, .5, 0, -.5, 0, 1, 0, -1, float32(math.NaN()), float32(math.NaN())}
	e, _ := openEditorFixture(t, input, 2)
	before := e.editResult(false)
	p := analysisParams(e, "statistics", 1, 5, 2)
	r, err := e.startAnalysis(p)
	if err != nil {
		t.Fatal(err)
	}
	r, _ = finishAnalysis(t, e, r)
	if len(r.Statistics) != 1 || r.Statistics[0].Channel != 1 || r.Statistics[0].Peak != 1 || math.Abs(r.Statistics[0].DC) > 1e-14 || math.Abs(r.Statistics[0].RMS-math.Sqrt(.625)) > 1e-14 || r.Statistics[0].ZeroCrossings != 3 || r.Statistics[0].ClippedSamples != 2 || r.IntegratedLUFS != nil {
		t.Fatal(r)
	}
	if !reflect.DeepEqual(before, e.editResult(false)) {
		t.Fatal("analysis mutated source/history")
	}
	p = analysisParams(e, "statistics", 0, 6, 2)
	r, err = e.startAnalysis(p)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = e.dispatchAnalysis(protocol.MethodAnalysisStep, []byte(mustJSON(t, protocol.AnalysisJobParams{DocumentID: r.DocumentID, JobID: r.JobID}))); err == nil || e.analysis.analysisJob != nil {
		t.Fatal("included nonfinite must reject and release", err)
	}
	p = analysisParams(e, "pitch", 1, 5, 2)
	r, err = e.startAnalysis(p)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = e.startAnalysis(p); err == nil {
		t.Fatal("concurrent job")
	}
	params := protocol.AnalysisJobParams{DocumentID: r.DocumentID, JobID: r.JobID}
	for range 2 {
		value, err := e.dispatchAnalysis(protocol.MethodAnalysisCancel, []byte(mustJSON(t, params)))
		if err != nil || value.(protocol.AnalysisJobResult).State != "cancelled" {
			t.Fatal("idempotent cancel", err)
		}
	}
	if _, err = e.dispatchAnalysis(protocol.MethodAnalysisStep, []byte(mustJSON(t, params))); err == nil {
		t.Fatal("step cancelled")
	}
}

func TestAnalysisClippingBoundaryUnionSingleUndoAndStaleCommit(t *testing.T) {
	input := make([]float32, 2051*2)
	for frame := 1022; frame < 1028; frame++ {
		input[frame*2] = 1
	}
	for frame := 1025; frame < 1030; frame++ {
		input[frame*2+1] = -1
	}
	e, _ := openEditorFixture(t, input, 2)
	p := analysisParams(e, "clipping", 0, 2051, 3)
	r, err := e.startAnalysis(p)
	if err != nil {
		t.Fatal(err)
	}
	r, _ = finishAnalysis(t, e, r)
	if r.MarkerCount != 1 || r.Statistics[0].ClippedSamples != 6 || r.Statistics[1].ClippedSamples != 5 {
		t.Fatal(r)
	}
	if _, err = e.startAnalysis(p); err == nil {
		t.Fatal("ready clipping reservation")
	}
	before := e.editResult(false)
	value, err := e.dispatchAnalysis(protocol.MethodAnalysisCommit, []byte(mustJSON(t, protocol.AnalysisJobParams{DocumentID: r.DocumentID, JobID: r.JobID})))
	if err != nil {
		t.Fatal(err)
	}
	result := value.(protocol.EditResult)
	if !result.Changed || len(result.Timeline.Markers) != 1 || result.Timeline.Markers[0].Frame != 1022 || len(result.History.Entries) != 2 {
		t.Fatal(result)
	}
	if !reflect.DeepEqual(input, editSamples(t, e)) {
		t.Fatal("clipping changed samples")
	}
	if _, err = e.navigateHistory(protocol.MethodEditUndo, e.doc.editor.documentID, ""); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before.Timeline.Markers, e.editResult(false).Timeline.Markers) {
		t.Fatal("undo markers")
	}
	p.DocumentID = e.doc.editor.documentID
	r, err = e.startAnalysis(p)
	if err != nil {
		t.Fatal(err)
	}
	r, _ = finishAnalysis(t, e, r)
	if _, err = e.navigateHistory(protocol.MethodEditRedo, e.doc.editor.documentID, ""); err != nil {
		t.Fatal(err)
	}
	if _, err = e.dispatchAnalysis(protocol.MethodAnalysisCommit, []byte(mustJSON(t, protocol.AnalysisJobParams{DocumentID: r.DocumentID, JobID: r.JobID}))); err == nil {
		t.Fatal("stale commit")
	}
	if _, err = e.dispatchAnalysis(protocol.MethodAnalysisCancel, []byte(mustJSON(t, protocol.AnalysisJobParams{DocumentID: r.DocumentID, JobID: r.JobID}))); err != nil {
		t.Fatal("stale private cleanup", err)
	}
}

func TestAnalysisSpectrumAllChannelsCalibratedSmoothingAndEntireRange(t *testing.T) {
	input := make([]float32, 8192*2)
	for frame := range 8192 {
		input[frame*2] = float32(.5 * math.Sin(2*math.Pi*float64(frame)*32/2048))
		input[frame*2+1] = float32(.25 * math.Sin(2*math.Pi*float64(frame)*64/2048))
	}
	for _, smooth := range []float64{0, 3, 6, 12, 24} {
		e, _ := openEditorFixture(t, input, 2)
		p := analysisParams(e, "spectrum", 0, 8192, 3)
		p.FFTSize = 2048
		p.Averaging = 1
		p.Window = "rectangular"
		p.Smoothing = smooth
		r, err := e.startAnalysis(p)
		if err != nil {
			t.Fatal(err)
		}
		r, data := finishAnalysis(t, e, r)
		if len(data) != 2*1025*16 || r.Bins != 1025 {
			t.Fatal(r, len(data))
		}
		if smooth == 0 {
			for channel, bin := range []int{32, 64} {
				db := math.Float64frombits(binary.LittleEndian.Uint64(data[(channel*1025+bin)*16+8:]))
				want := -6.020599913279624 - float64(channel)*6.020599913279624
				if math.Abs(db-want) > .00001 {
					t.Fatalf("channel%d calibrated got%g want%g", channel, db, want)
				}
			}
		}
	}
	// Default one-window selection spectrum is centred across the selection,
	// rather than always reading the first quiet42ms.
	input = make([]float32, 8192)
	for frame := 3072; frame < 5120; frame++ {
		input[frame] = float32(.5 * math.Sin(2*math.Pi*float64(frame)*32/2048))
	}
	e, _ := openEditorFixture(t, input, 1)
	p := analysisParams(e, "spectrum", 0, 8192, 1)
	p.FFTSize = 2048
	p.Window = "rectangular"
	r, err := e.startAnalysis(p)
	if err != nil {
		t.Fatal(err)
	}
	_, data := finishAnalysis(t, e, r)
	db := math.Float64frombits(binary.LittleEndian.Uint64(data[32*16+8:]))
	if math.Abs(db+6.020599913279624) > .00001 {
		t.Fatal(db)
	}
}

func TestAnalysisPitchCooperativeTracks440HzAndCancel(t *testing.T) {
	input := make([]float32, 4800)
	for i := range input {
		input[i] = float32(.4 * math.Sin(2*math.Pi*440*float64(i)/48000))
	}
	e, _ := openEditorFixture(t, input, 1)
	p := analysisParams(e, "pitch", 0, 4800, 1)
	p.HopSize = 800
	r, err := e.startAnalysis(p)
	if err != nil {
		t.Fatal(err)
	}
	initial := r
	e.analysis.analysisJob.now = analysisTestClock(analysisStepBudget)
	value, err := e.dispatchAnalysis(protocol.MethodAnalysisStep, []byte(mustJSON(t, protocol.AnalysisJobParams{DocumentID: r.DocumentID, JobID: r.JobID})))
	if err != nil {
		t.Fatal(err)
	}
	r = value.(protocol.AnalysisJobResult)
	if r.ProcessedFrames != initial.ProcessedFrames || r.Records != 0 {
		t.Fatal("pitch did not yield within first frame")
	}
	e.analysis.analysisJob.now = nil
	r, data := finishAnalysis(t, e, r)
	if r.Records != 6 || len(data) != 6*32 {
		t.Fatal(r, len(data))
	}
	for record := 1; record < 5; record++ {
		hz := math.Float64frombits(binary.LittleEndian.Uint64(data[record*32+16:]))
		confidence := math.Float64frombits(binary.LittleEndian.Uint64(data[record*32+24:]))
		if math.Abs(hz-440) > 1 || confidence < .95 {
			t.Fatal(record, hz, confidence)
		}
	}
	for _, bad := range []float64{1e-12, -1, math.NaN(), math.Inf(1)} {
		p.MinHz = bad
		if _, err = e.startAnalysis(p); err == nil {
			t.Fatal("unbounded pitch accepted", bad)
		}
	}
}

// One second of default-range pitch analysis (60-1600 Hz, ~640k YIN units per
// frame) must not cost one bridge round trip per 4096 units: that made the
// analysis take seconds in WASM under load. Steps stay cooperative inside a
// frame (see the test above) but carry a much larger work budget.
func TestAnalysisPitchStepBudgetBoundsRoundTrips(t *testing.T) {
	input := make([]float32, 48000)
	for i := range input {
		input[i] = float32(.4 * math.Sin(2*math.Pi*440*float64(i)/48000))
	}
	e, _ := openEditorFixture(t, input, 1)
	r, err := e.startAnalysis(analysisParams(e, "pitch", 0, 48000, 1))
	if err != nil {
		t.Fatal(err)
	}
	// Deterministically spend 64 small YIN units per bridge call. The real
	// clock chooses the count by elapsed time, without changing DSP work.
	e.analysis.analysisJob.now = analysisTestClock(analysisStepBudget / 64)
	steps := 0
	for ; steps < 20000 && r.State != "ready"; steps++ {
		value, err := e.dispatchAnalysis(protocol.MethodAnalysisStep, []byte(mustJSON(t, protocol.AnalysisJobParams{DocumentID: r.DocumentID, JobID: r.JobID})))
		if err != nil {
			t.Fatal(err)
		}
		r = value.(protocol.AnalysisJobResult)
	}
	if r.State != "ready" || r.Records != 60 {
		t.Fatal("pitch did not finish", r)
	}
	if steps > 200 {
		t.Fatalf("pitch needed %d analysis.step round trips for one second", steps)
	}
}

func TestAnalysisSpectrogramAllHopsProgressCacheAndTilePartition(t *testing.T) {
	input := make([]float32, 8192)
	input[768] = 1 // Far from the single pixel centre.
	e, _ := openEditorFixture(t, input, 1)
	p := analysisParams(e, "spectrogram", 0, 8192, 1)
	p.Width = 2
	p.Height = 64
	p.FFTSize = 256
	p.MinDB = -100
	p.ColorMap = "grayscale"
	r, err := e.startAnalysis(p)
	if err != nil {
		t.Fatal(err)
	}
	partials := 0
	e.analysis.analysisJob.now = analysisTestClock(analysisStepBudget)
	for r.State != "ready" {
		v, err := e.dispatchAnalysis(protocol.MethodAnalysisStep, []byte(mustJSON(t, protocol.AnalysisJobParams{DocumentID: r.DocumentID, JobID: r.JobID})))
		if err != nil {
			t.Fatal(err)
		}
		r = v.(protocol.AnalysisJobResult)
		data := e.TakeData()
		if r.DataBytes > 0 {
			if len(data) != 2*64*4 {
				t.Fatal("partial dimensions")
			}
			partials++
		}
	}
	if partials < 2 {
		t.Fatal("not progressive")
	}
	full := append([]byte(nil), e.analysis.analysisJob.data...)
	visible := false
	for row := range 64 {
		visible = visible || full[row*8] > 0
	}
	if !visible {
		t.Fatal("transient between pixel centres disappeared")
	}
	r, err = e.startAnalysis(p)
	if err != nil || r.State != "ready" || !reflect.DeepEqual(e.TakeData(), full) {
		t.Fatal("immutable zoom cache", err)
	}
	for tile := range 2 {
		p.Start = int64(tile * 4096)
		p.End = p.Start + 4096
		p.Width = 1
		r, err = e.startAnalysis(p)
		if err != nil {
			t.Fatal(err)
		}
		_, data := finishAnalysis(t, e, r)
		for row := range 64 {
			if !reflect.DeepEqual(data[row*4:row*4+4], full[(row*2+tile)*4:(row*2+tile)*4+4]) {
				t.Fatal("tile seam", tile, row)
			}
		}
	}
}

func TestSpectrogramRowsPreserveEveryBinAndEndpoints(t *testing.T) {
	for _, height := range []int{1, 3, 7, 10} {
		for peak := range 7 {
			levels := []float64{-100, -100, -100, -100, -100, -100, -100}
			levels[peak] = 0
			visible := false
			for row := range height {
				visible = visible || spectrogramRowLevel(levels, row, height) == 0
			}
			if !visible {
				t.Fatal("frequency bin disappeared", height, peak)
			}
			if peak == 0 && spectrogramRowLevel(levels, height-1, height) != 0 {
				t.Fatal("DC must appear in the bottom row")
			}
			if peak == 6 && spectrogramRowLevel(levels, 0, height) != 0 {
				t.Fatal("Nyquist must appear in the top row")
			}
		}
	}
}

func TestAnalysisSpectrogramNarrowToneAndGainPixels(t *testing.T) {
	// Bin 75 (439.453125 Hz) falls between the former single-bin row samples
	// at this image height. A coherent tone gives an independent amplitude and
	// grayscale oracle without relying on the kernel FFT to compute expectations.
	const frames, size, height, peakBin = 16384, 8192, 160, 75
	var images [2][]byte
	for version, gainDB := range []float64{0, -12} {
		amplitude := .5 * math.Pow(10, gainDB/20)
		input := make([]float32, frames)
		for i := range input {
			input[i] = float32(amplitude * math.Sin(2*math.Pi*peakBin*float64(i)/size))
		}
		e, _ := openEditorFixture(t, input, 1)
		p := analysisParams(e, "spectrogram", 4096, 12288, 1)
		p.Width, p.Height, p.FFTSize, p.MinDB, p.ColorMap = 1, height, size, -100, "grayscale"
		r, err := e.startAnalysis(p)
		if err != nil {
			t.Fatal(err)
		}
		_, images[version] = finishAnalysis(t, e, r)
		row := height - 1 - peakBin*height/(size/2+1)
		pixel := images[version][row*4 : row*4+4]
		expected := math.Round(255 * (20*math.Log10(amplitude) + 100) / 100)
		if math.Abs(float64(pixel[0])-expected) > 1 || pixel[1] != pixel[0] || pixel[2] != pixel[0] || pixel[3] != 255 {
			t.Fatal("narrow tone amplitude lost", gainDB, row, pixel, expected)
		}
		if !reflect.DeepEqual(input, editSamples(t, e)) {
			t.Fatal("spectrogram changed the source")
		}
	}
	if reflect.DeepEqual(images[0], images[1]) {
		t.Fatal("12 dB source gain must change spectrogram pixels")
	}
}

func TestAnalysisValidationPublicEnvelopeAndNoStaleBinary(t *testing.T) {
	e, _ := openEditorFixture(t, make([]float32, 256), 1)
	for _, method := range []string{protocol.MethodAnalysisStart, protocol.MethodAnalysisStep, protocol.MethodAnalysisCancel, protocol.MethodAnalysisCommit, protocol.MethodAnalysisSpectrum, protocol.MethodMetersConfigure} {
		for _, bad := range []string{"{", "[]", "null"} {
			if method == protocol.MethodMetersConfigure && bad == "null" {
				continue
			}
			var reply protocol.Response
			if err := json.Unmarshal(e.CallWithData(method, []byte(bad), nil), &reply); err != nil || reply.OK || len(e.TakeData()) != 0 {
				t.Fatal(method, bad, reply)
			}
		}
	}
	for _, p := range []protocol.AnalysisStartParams{
		{Kind: "unknown"},
		{Kind: "spectrum", FFTSize: 300},
		{Kind: "spectrum", Window: "unknown"},
		{Kind: "spectrum", Averaging: 65},
		{Kind: "spectrum", Smoothing: 2},
		{Kind: "spectrogram", Width: math.MaxInt, Height: 512},
		{Kind: "spectrogram", Width: 1, Height: 1, ColorMap: "unknown"},
		{Kind: "spectrogram", Width: 1, Height: 1, MinDB: 10, MaxDB: 0},
		{Kind: "clipping", Threshold: math.NaN()},
	} {
		p.SelectionResult = protocol.SelectionResult{DocumentID: e.doc.editor.documentID, SelectionRange: protocol.SelectionRange{End: 256, ChannelMask: 1}}
		if _, err := e.startAnalysis(p); err == nil {
			t.Fatal("invalid params", p)
		}
	}
}
