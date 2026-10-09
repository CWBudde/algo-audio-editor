package engine

import (
	"encoding/json"
	"math"
	"math/rand/v2"
	"reflect"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func restorationFixture(frames, channels int) []float32 {
	input := make([]float32, frames*channels)
	for frame := range frames {
		v := float32(0.4 * math.Sin(2*math.Pi*440*float64(frame)/48000))
		for ch := range channels {
			input[frame*channels+ch] = v * float32(ch+1) / float32(channels)
		}
	}
	return input
}

func restorationParams(e *Engine, op string) protocol.ProcessStartParams {
	p := processParams(e, 0, e.doc.document.Frames(), (1<<e.doc.document.Channels())-1, 0)
	p.Operation = protocol.OperationName(op)
	p.FFTSize = 2048
	p.ReductionDB = 24
	p.NoiseMethod = "wiener"
	p.Sensitivity = 8
	p.ClipThreshold = 0.25
	p.MaxGap = 64
	p.DurationRatio = 1.5
	p.HumHz = 50
	p.HumQ = 30
	p.Harmonics = 8
	return p
}

func TestRestorationPrivatePreviewCommitUndo(t *testing.T) {
	for _, op := range []string{"spectral-attenuate", "spectral-remove", "spectral-heal", "noise-reduce", "remove-clicks", "declip", "time-stretch", "remove-hum"} {
		t.Run(op, func(t *testing.T) {
			input := restorationFixture(12000, 2)
			e, _ := openEditorFixture(t, input, 2)
			setTimelineFixture(t, e, []protocol.TimelineMarker{{ID: 1, Frame: 4000, Name: "inside", Color: "#112233"}, {ID: 2, Frame: 11000, Name: "tail", Color: "#112233"}}, []protocol.TimelineRegion{{ID: 3, Start: 3000, End: 5000, Name: "phrase", Color: "#112233"}})
			before := e.editResult(false)
			p := restorationParams(e, op)
			if op == "noise-reduce" {
				profile := protocol.SelectionResult{DocumentID: p.DocumentID, SelectionRange: protocol.SelectionRange{Start: 0, End: 2048, ChannelMask: 3}}
				p.NoiseProfile = &profile
			}
			if op == "spectral-attenuate" || op == "spectral-remove" {
				p.Start, p.End = 2000, 8000
				p.SpectralMask = &protocol.SpectralMask{Start: p.Start, End: p.End, LowHz: 300, HighHz: 600}
				if op == "spectral-attenuate" {
					p.GainDB = -12
				}
			}
			if op == "spectral-heal" {
				p.Start, p.End = 6000, 6004
				p.SpectralMask = &protocol.SpectralMask{Start: p.Start, End: p.End, HighHz: 24000}
			}
			if op == "time-stretch" {
				p.Start, p.End = 2000, 8000
			}
			ready := finishEngineNormalization(t, e, startEngineProcess(t, e, p))
			if !reflect.DeepEqual(e.editResult(false), before) {
				t.Fatal("private job mutated source")
			}
			if _, err := e.playDocument(protocol.TransportPlayParams{Start: ready.Candidate.Start, End: &ready.Candidate.End, PreviewJobID: ready.JobID}); err != nil {
				t.Fatal(err)
			}
			if n := e.Render(make([]float32, 1024)); n == 0 {
				t.Fatal("empty preview")
			}
			after, err := e.commitProcess(jobParams(ready))
			if err != nil {
				t.Fatal(err)
			}
			if !after.Changed || len(after.History.Entries) != len(before.History.Entries)+1 {
				t.Fatal("not one edit")
			}
			output := editSamples(t, e)
			if op == "time-stretch" {
				if after.Document.Frames != 15000 || after.Selection.Start != 2000 || after.Selection.End != 11000 || after.Timeline.Markers[0].Frame != 5000 || after.Timeline.Markers[1].Frame != 14000 || after.Timeline.Regions[0].Start != 3500 || after.Timeline.Regions[0].End != 6500 {
					t.Fatal("stretch geometry", after)
				}
			}
			_ = historyNavigate(t, e, protocol.MethodEditUndo, "")
			assertEditBits(t, editSamples(t, e), input)
			_ = historyNavigate(t, e, protocol.MethodEditRedo, "")
			assertEditBits(t, editSamples(t, e), output)
		})
	}
}

func TestSpectralHealClickAndUntouchedChannels(t *testing.T) {
	original := restorationFixture(12000, 2)
	damaged := append([]float32(nil), original...)
	for i := 6000; i < 6004; i++ {
		damaged[i*2] += 0.8
	}
	e, _ := openEditorFixture(t, damaged, 2)
	p := restorationParams(e, "spectral-heal")
	p.Start, p.End, p.ChannelMask = 6000, 6004, 1
	p.SpectralMask = &protocol.SpectralMask{Start: 6000, End: 6004, HighHz: 24000}
	ready := finishEngineNormalization(t, e, startEngineProcess(t, e, p))
	if _, err := e.commitProcess(jobParams(ready)); err != nil {
		t.Fatal(err)
	}
	repaired := editSamples(t, e)
	errorEnergy := 0.0
	for i := range repaired {
		if i%2 == 1 || i/2 < 6000 || i/2 >= 6004 {
			if math.Float32bits(repaired[i]) != math.Float32bits(damaged[i]) {
				t.Fatal("changed outside mask")
			}
		}
		d := float64(repaired[i] - original[i])
		errorEnergy += d * d
	}
	db := 10 * math.Log10(errorEnergy/float64(len(repaired)))
	t.Logf("stored float32 click residual %.2f dBFS", db)
	if db > -80 {
		t.Fatal("click residual", db)
	}
}

func TestNoiseReductionDefaultAcceptance(t *testing.T) {
	rng := rand.New(rand.NewPCG(5, 7))
	input := make([]float32, 96000)
	for i := range input {
		input[i] = float32(0.02 * rng.NormFloat64())
	}
	e, _ := openEditorFixture(t, input, 1)
	p := restorationParams(e, "noise-reduce")
	p.Start, p.End = 24000, 96000
	p.NoiseProfile = &protocol.SelectionResult{DocumentID: p.DocumentID, SelectionRange: protocol.SelectionRange{End: 24000, ChannelMask: 1}}
	started := startEngineProcess(t, e, p)
	if started.Phase != "analyzing" || started.PhaseCount != 2 {
		t.Fatal("no capture phase")
	}
	ready := finishEngineNormalization(t, e, started)
	if _, err := e.commitProcess(jobParams(ready)); err != nil {
		t.Fatal(err)
	}
	out := editSamples(t, e)
	before, after := 0.0, 0.0
	for i := range input {
		if i < 24000 {
			if input[i] != out[i] {
				t.Fatal("profile audio changed")
			}
			continue
		}
		before += float64(input[i]) * float64(input[i])
		after += float64(out[i]) * float64(out[i])
	}
	db := 10 * math.Log10(before/after)
	t.Logf("stored default stationary noise reduction %.2f dB", db)
	if db < 15 {
		t.Fatal("acceptance failed", db)
	}
}

func TestRestorationFailureCancelAndABI(t *testing.T) {
	e, _ := openEditorFixture(t, restorationFixture(12000, 2), 2)
	for _, op := range []string{"spectral-attenuate", "spectral-remove", "spectral-heal", "noise-reduce", "remove-clicks", "declip", "time-stretch", "remove-hum"} {
		before := e.editResult(false)
		p := restorationParams(e, op)
		p.FFTSize = 3
		p.Sensitivity = 0
		p.ClipThreshold = 2
		p.DurationRatio = 100
		p.HumHz = 55
		raw, _ := json.Marshal(p)
		var reply protocol.Response
		if err := json.Unmarshal(e.Call(protocol.MethodProcessStart, raw), &reply); err != nil || reply.OK || e.jobs.processJob != nil || !reflect.DeepEqual(before, e.editResult(false)) {
			t.Fatal("bad ABI mutated", op, reply)
		}
	}
	p := restorationParams(e, "noise-reduce")
	p.NoiseProfile = &protocol.SelectionResult{DocumentID: "stale", SelectionRange: protocol.SelectionRange{End: 2048, ChannelMask: 3}}
	if _, err := e.startProcess(p, nil); err == nil {
		t.Fatal("accepted stale profile")
	}
	p.NoiseProfile.DocumentID = p.DocumentID
	p.NoiseProfile.ChannelMask = 1
	if _, err := e.startProcess(p, nil); err == nil {
		t.Fatal("uncovered channel")
	}
	p = restorationParams(e, "spectral-heal")
	p.Start, p.End = 5000, 6000
	p.SpectralMask = &protocol.SpectralMask{Start: 5000, End: 6000, HighHz: 24000}
	if _, err := e.startProcess(p, nil); err == nil {
		t.Fatal("long heal")
	}
	p = restorationParams(e, "time-stretch")
	p.ChannelMask = 1
	if _, err := e.startProcess(p, nil); err == nil {
		t.Fatal("independent time stretch")
	}
	for _, op := range []string{"time-stretch", "remove-clicks", "remove-hum", "noise-reduce"} {
		p = restorationParams(e, op)
		if op == "noise-reduce" {
			p.NoiseProfile = &protocol.SelectionResult{DocumentID: p.DocumentID, SelectionRange: protocol.SelectionRange{End: 2048, ChannelMask: 3}}
		}
		before := e.editResult(false)
		started := startEngineProcess(t, e, p)
		if _, err := e.stepProcess(jobParams(started)); err != nil {
			t.Fatal(err)
		}
		if _, err := e.cancelProcess(jobParams(started)); err != nil {
			t.Fatal(err)
		}
		if e.jobs.processJob != nil || !reflect.DeepEqual(before, e.editResult(false)) {
			t.Fatal("cancel mutated source")
		}
		if _, err := e.commitProcess(jobParams(started)); err == nil {
			t.Fatal("cancelled commit")
		}
	}
}
