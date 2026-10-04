package engine

import (
	"encoding/binary"
	"math"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
	"github.com/cwbudde/algo-dsp/measure/loudness"
	"github.com/cwbudde/algo-dsp/measure/truepeak"
)

func meterValues(t *testing.T, e *Engine) [protocol.MetersFloat64Count]float64 {
	t.Helper()
	data := e.MeterData()
	if len(data) != protocol.MetersDataBytes {
		t.Fatal("meter block", len(data))
	}
	var values [protocol.MetersFloat64Count]float64
	for i := range values {
		values[i] = math.Float64frombits(binary.LittleEndian.Uint64(data[i*8:]))
	}
	return values
}

func TestMetersActualOutputEOFPaddingResetAndReadOnly(t *testing.T) {
	e, _ := openEditorFixture(t, []float32{.25, -.5, .75}, 1)
	if _, err := e.configure(protocol.EngineConfigureParams{SampleRate: 48000, Channels: 1}); err != nil {
		t.Fatal(err)
	}
	before := e.editResult(false)
	if len(e.MeterData()) != 0 {
		t.Fatal("enabled eagerly")
	}
	if _, err := e.configureMeters(protocol.MetersConfigureParams{}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.playDocument(protocol.TransportPlayParams{}); err != nil {
		t.Fatal(err)
	}
	output := make([]float32, 16)
	if n := e.Render(output); n != 3 {
		t.Fatal(n)
	}
	v := meterValues(t, e)
	if v[0] != 1 || v[1] != 1 || v[2] != 3 || v[3] != 48000 || v[16] != .75 || v[18] != .75 || math.Abs(v[17]-math.Sqrt((.0625+.25+.5625)/3)) > 1e-14 {
		t.Fatal(v[:20])
	}
	if !math.IsInf(v[6], -1) || v[12] != 0 {
		t.Fatal("short loudness availability")
	}
	e.Render(output) // Render at EOF must not add padding frames.
	if meterValues(t, e)[2] != 3 {
		t.Fatal("padded EOF counted")
	}
	if !reflectMetersSource(before, e) {
		t.Fatal("meter changed source/history")
	}
	if _, err := e.seekDocument(protocol.TransportSeekParams{Frame: 1}); err != nil {
		t.Fatal(err)
	}
	if meterValues(t, e)[2] != 0 || meterValues(t, e)[18] != 0 {
		t.Fatal("seek reset")
	}
	if _, err := e.playDocument(protocol.TransportPlayParams{}); err != nil {
		t.Fatal(err)
	}
	e.Render(output)
	reset := true
	if _, err := e.configureMeters(protocol.MetersConfigureParams{Reset: reset}); err != nil {
		t.Fatal(err)
	}
	if meterValues(t, e)[2] != 0 {
		t.Fatal("explicit reset")
	}
	falseValue := false
	if _, err := e.configureMeters(protocol.MetersConfigureParams{Enabled: &falseValue}); err != nil || len(e.MeterData()) != 0 {
		t.Fatal("disable", err)
	}
}

func reflectMetersSource(before protocol.EditResult, e *Engine) bool {
	return before.History.CurrentStateID == e.history.CurrentID() && before.Document.DocumentID == e.editor.documentID
}

func TestMetersEffectAndResamplerMeasureRenderedOutput(t *testing.T) {
	input := make([]float32, 48000*2)
	for frame := range 48000 {
		input[frame*2] = .5
		input[frame*2+1] = -.5
	}
	e, _ := openEditorFixture(t, input, 2)
	_, err := e.configure(protocol.EngineConfigureParams{SampleRate: 44100, Channels: 2})
	if err != nil {
		t.Fatal(err)
	}
	_, err = e.configureMeters(protocol.MetersConfigureParams{})
	if err != nil {
		t.Fatal(err)
	}
	preview, err := e.startEffectPreview(protocol.MethodEffectsPreviewStart, effectParams(e, 0, 48000, 3, "widener", map[string]any{"width": 0.0, "mix": 1.0}))
	if err != nil {
		t.Fatal(err)
	}
	_, err = e.playDocument(protocol.TransportPlayParams{EffectPreviewID: preview.PreviewID})
	if err != nil {
		t.Fatal(err)
	}
	output := make([]float32, 512*2)
	frames := 0
	for {
		n := e.Render(output)
		frames += n
		if n < 512 {
			break
		}
	}
	v := meterValues(t, e)
	if v[2] != float64(frames) || frames != 44100 || v[16] != 0 || v[17] != 0 || v[19] != 0 || v[20] != 0 || v[8] != 0 || !math.IsInf(v[6], -1) {
		t.Fatal("meter measured dry input or source-rate frames", v[:24], frames)
	}
}

func TestMetersTruePeakNaturalEOFFlushAndUnsafeInput(t *testing.T) {
	input := []float32{.4, -.2, .5, -.1, .7, -.7, .6, -.4}
	p, _ := truepeak.NewMeter(1)
	if err := p.ProcessInterleaved32(input); err != nil {
		t.Fatal(err)
	}
	before := make([]float64, 1)
	_ = p.PeaksInto(before)
	p.Flush()
	after := make([]float64, 1)
	_ = p.PeaksInto(after)
	if after[0] <= before[0] {
		t.Fatal("fixture must exercise FIR tail", before, after)
	}
	e, _ := openEditorFixture(t, input, 1)
	_, _ = e.configure(protocol.EngineConfigureParams{SampleRate: 48000, Channels: 1})
	_, _ = e.configureMeters(protocol.MetersConfigureParams{})
	_, _ = e.playDocument(protocol.TransportPlayParams{})
	e.Render(make([]float32, 16))
	if meterValues(t, e)[19] != after[0] {
		t.Fatal("natural EOF omitted reconstruction tail")
	}
	e, _ = openEditorFixture(t, []float32{.5, float32(math.NaN())}, 1)
	_, _ = e.configure(protocol.EngineConfigureParams{SampleRate: 48000, Channels: 1})
	_, _ = e.configureMeters(protocol.MetersConfigureParams{})
	_, _ = e.playDocument(protocol.TransportPlayParams{})
	output := make([]float32, 2)
	e.Render(output)
	if !math.IsNaN(float64(output[1])) || meterValues(t, e)[14] != 1 {
		t.Fatal("unsafe imported bits or meter failure flag")
	}
}

func TestMetersPreparedRenderAndCopyZeroAllocations(t *testing.T) {
	e := New()
	_, err := e.configureMeters(protocol.MetersConfigureParams{})
	if err != nil {
		t.Fatal(err)
	}
	output := make([]float32, 512*2)
	e.Render(output)
	_ = e.MeterData()
	if allocations := testing.AllocsPerRun(20, func() { e.Render(output); _ = e.MeterData() }); allocations != 0 {
		t.Fatal(allocations)
	}
	old := e.meters
	if _, err := e.configure(protocol.EngineConfigureParams{SampleRate: math.NaN(), Channels: 2}); err == nil || e.meters != old {
		t.Fatal("failed format configure altered meters")
	}
	if _, err := e.configure(protocol.EngineConfigureParams{SampleRate: 96000, Channels: 6}); err != nil || e.meters == old || e.meters.channels != 6 {
		t.Fatal("successful format configure", err)
	}
}

func TestMetersSpeakerWeightsAndSelectedLFENoLoudness(t *testing.T) {
	input := make([]float32, 48000*6)
	for frame := range 48000 {
		for c := range 6 {
			input[frame*6+c] = float32(.1 * math.Sin(2*math.Pi*1000*float64(frame)/48000))
		}
	}
	e, _ := openEditorFixture(t, input, 6)
	_, _ = e.configure(protocol.EngineConfigureParams{SampleRate: 48000, Channels: 6})
	_, err := e.configureMeters(protocol.MetersConfigureParams{})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = e.playDocument(protocol.TransportPlayParams{})
	ref, err := loudness.NewStreamingMeter(loudness.IntegratedConfig{SampleRate: 48000, Channels: 6, ChannelWeights: []float64{1, 1, 1, 0, 1.41, 1.41}, MaxFrames: 48000})
	if err != nil {
		t.Fatal(err)
	}
	output := make([]float32, 512*6)
	for {
		n := e.Render(output)
		if err := ref.ProcessInterleaved32(output[:n*6]); err != nil {
			t.Fatal(err)
		}
		if n < 512 {
			break
		}
	}
	if math.Abs(meterValues(t, e)[6]-ref.Snapshot().Integrated) > 1e-12 {
		t.Fatal("speaker weights")
	}
	p := analysisParams(e, "statistics", 0, 48000, 1<<3)
	r, err := e.startAnalysis(p)
	if err != nil {
		t.Fatal(err)
	}
	r, _ = finishAnalysis(t, e, r)
	if r.IntegratedLUFS != nil || r.Statistics[0].RMS <= 0 {
		t.Fatal("LFE-only time stats", r)
	}
}

func TestAnalysisLiveSpectrumSteppedIdentityRolling64AndCancellation(t *testing.T) {
	e := New()
	p := protocol.AnalysisSpectrumParams{Source: "playback", FFTSize: 256, Window: "rectangular", Averaging: 64}
	// Enable output capture, then replace this initial all-zero snapshot.
	_, err := e.playbackSpectrum(p)
	if err != nil {
		t.Fatal(err)
	}
	setHistory := func(amplitude float32) {
		e.spectrumCount = 256
		e.spectrumWrite = 256
		for i := range 256 {
			for c := range 2 {
				e.spectrumHistory[i*2+c] = amplitude
			}
		}
	}
	for poll := 0; poll < 64; poll++ {
		amplitude := float32(0)
		if poll == 0 {
			amplitude = 1
		}
		setHistory(amplitude)
		r, err := e.playbackSpectrum(p)
		if err != nil {
			t.Fatal(err)
		}
		if r.State != "running" || r.DataBytes != 0 {
			t.Fatal("unbounded first call", r)
		}
		step := p
		step.JobID = r.JobID
		for r.State != "ready" {
			r, err = e.playbackSpectrum(step)
			if err != nil {
				t.Fatal(err)
			}
		}
		data := e.TakeData()
		if len(data) != 2*129*16 {
			t.Fatal(len(data))
		}
		if poll == 63 {
			db := math.Float64frombits(binary.LittleEndian.Uint64(data[8:]))
			want := -10 * math.Log10(64)
			if math.Abs(db-want) > 1e-12 {
				t.Fatal("64-frame rolling average", db, want)
			}
		}
	}
	setHistory(.5)
	r, err := e.playbackSpectrum(p)
	if err != nil {
		t.Fatal(err)
	}
	params := protocol.AnalysisJobParams{DocumentID: r.DocumentID, JobID: r.JobID}
	if _, err := e.dispatchAnalysis(protocol.MethodAnalysisCancel, []byte(mustJSON(t, params))); err != nil {
		t.Fatal(err)
	}
	p.JobID = r.JobID
	if _, err := e.playbackSpectrum(p); err == nil {
		t.Fatal("cancelled live job accepted")
	}
}

func BenchmarkMetersRenderAndCopy(b *testing.B) {
	e := New()
	_, err := e.configureMeters(protocol.MetersConfigureParams{})
	if err != nil {
		b.Fatal(err)
	}
	output := make([]float32, 1024)
	e.Render(output)
	_ = e.MeterData()
	b.ReportAllocs()
	for b.Loop() {
		e.Render(output)
		_ = e.MeterData()
	}
}
