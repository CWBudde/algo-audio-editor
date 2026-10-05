package engine

import (
	"encoding/binary"
	"encoding/json"
	"math"
	"reflect"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func effectGraph(effect string, params map[string]any) protocol.EffectGraph {
	return protocol.EffectGraph{Nodes: []protocol.EffectNode{{ID: "_input", Type: "_input"}, {ID: "fx", Type: effect, Params: params}, {ID: "_output", Type: "_output"}}, Connections: []protocol.EffectConnection{{From: "_input", To: "fx"}, {From: "fx", To: "_output"}}}
}

func effectParams(e *Engine, start, end int64, mask int, effect string, params map[string]any) protocol.EffectsPreviewParams {
	return protocol.EffectsPreviewParams{SelectionResult: protocol.SelectionResult{DocumentID: e.doc.editor.documentID, SelectionRange: protocol.SelectionRange{Start: start, End: end, ChannelMask: mask}}, Graph: effectGraph(effect, params)}
}

func effectRPCCall(t *testing.T, e *Engine, method string, p any, input []byte) protocol.Response {
	t.Helper()
	payload, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	var result protocol.Response
	if err := json.Unmarshal(e.CallWithData(method, payload, input), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestEffectActualPreviewOfflineApplySingleUndoAndSelectionOwnership(t *testing.T) {
	input := make([]float32, 9001*3)
	for frame := range 9001 {
		input[frame*3] = float32(.3 * math.Sin(float64(frame)*.01))
		input[frame*3+1] = math.Float32frombits(0x80000000)
		input[frame*3+2] = float32(.1 * math.Cos(float64(frame)*.03))
	}
	e, _ := openEditorFixture(t, input, 3)
	if _, err := e.configure(protocol.EngineConfigureParams{SampleRate: 48000, Channels: 3}); err != nil {
		t.Fatal(err)
	}
	setTimelineFixture(t, e, []protocol.TimelineMarker{{ID: 1, Frame: 7, Name: "first", Color: "#123456"}}, []protocol.TimelineRegion{{ID: 2, Start: 3, End: 100, Name: "region", Color: "#654321"}})
	before := e.editResult(false)
	p := effectParams(e, 7, 8993, 5, "ringmod", map[string]any{"carrierHz": 750.0, "mix": 1.0})
	preview, err := e.startEffectPreview(protocol.MethodEffectsPreviewStart, p)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, e.editResult(false)) {
		t.Fatal("preview changed committed source/history")
	}
	end := p.End
	if _, err := e.playDocument(protocol.TransportPlayParams{Start: p.Start, End: &end, EffectPreviewID: preview.PreviewID}); err != nil {
		t.Fatal(err)
	}
	output := make([]float32, (p.End-p.Start)*3)
	scratch := make([]float32, 37*3)
	for position := 0; position < len(output)/3; position += 37 {
		count := min(37, len(output)/3-position)
		if n := e.Render(scratch[:count*3]); n != count {
			t.Fatal("preview short read", n, count)
		}
		copy(output[position*3:], scratch[:count*3])
	}
	meters, err := e.dispatchEffects(protocol.MethodEffectsPreviewMeters, []byte(mustJSON(t, protocol.EffectsSessionParams{DocumentID: p.DocumentID, PreviewID: preview.PreviewID})), nil)
	if err != nil {
		t.Fatal(err)
	}
	meter := meters.(protocol.EffectsMetersResult)
	if meter.Frames != p.End-p.Start || meter.InputPeak[1] != 0 || meter.OutputPeak[0] <= 0 {
		t.Fatal("actual preview meter", meter)
	}
	p.PreviewID = preview.PreviewID
	started, err := e.applyEffects(p)
	if err != nil {
		t.Fatal(err)
	}
	if e.effectsState.effectPreview != nil || e.playback.transport != nil {
		t.Fatal("apply retained live preview")
	}
	ready := finishEngineNormalization(t, e, started)
	if !reflect.DeepEqual(before, e.editResult(false)) {
		t.Fatal("private effects candidate changed source")
	}
	candidate := e.jobs.processJob.candidate
	for channel := range 3 {
		source, _ := candidate.Channel(channel)
		samples := make([]float32, p.End-p.Start)
		source.Read(samples, p.Start)
		for frame, value := range samples {
			if math.Float32bits(value) != math.Float32bits(output[frame*3+channel]) {
				t.Fatalf("channel%d frame%d actual preview/apply differ", channel, frame)
			}
		}
	}
	committed, err := e.commitProcess(jobParams(ready))
	if err != nil {
		t.Fatal(err)
	}
	if !committed.Changed || len(committed.History.Entries) != 2 || committed.History.Entries[1].Label != "Effects" {
		t.Fatal("rack did not create one effects undo", committed.History)
	}
	changed := editSamples(t, e)
	for frame := range 9001 {
		for channel := range 3 {
			if channel != 1 && int64(frame) >= p.Start && int64(frame) < p.End {
				continue
			}
			if math.Float32bits(changed[frame*3+channel]) != math.Float32bits(input[frame*3+channel]) {
				t.Fatal("unselected source bit changed")
			}
		}
	}
	undo := historyNavigate(t, e, protocol.MethodEditUndo, "")
	assertEditBits(t, editSamples(t, e), input)
	if undo.Selection.SelectionRange != p.SelectionRange {
		t.Fatal("undo lost submitted selection")
	}
	historyNavigate(t, e, protocol.MethodEditRedo, "")
	assertEditBits(t, editSamples(t, e), changed)
}

func TestEffectsProtocolValidationLiveUpdateAtomicAndHistoryFences(t *testing.T) {
	e, _ := openEditorFixture(t, []float32{.1, .2, .3, .4, .5, .6, .7, .8}, 2)
	p := effectParams(e, 0, 4, 3, "ringmod", nil)
	response := effectRPCCall(t, e, protocol.MethodEffectsPreviewStart, p, nil)
	if !response.OK {
		t.Fatal(response.Error)
	}
	var started protocol.EffectsPreviewResult
	if err := json.Unmarshal(response.Result, &started); err != nil {
		t.Fatal(err)
	}
	before := e.effectsState.effectPreview
	for _, change := range []func(*protocol.EffectsPreviewParams){func(p *protocol.EffectsPreviewParams) { p.DocumentID = "stale" }, func(p *protocol.EffectsPreviewParams) { p.PreviewID = "wrong" }, func(p *protocol.EffectsPreviewParams) { p.Graph.Nodes[1].Type = "invented" }, func(p *protocol.EffectsPreviewParams) { p.Graph.Nodes[1].Params = map[string]any{"missing": 1} }, func(p *protocol.EffectsPreviewParams) { v := 2.0; p.Wet = &v }, func(p *protocol.EffectsPreviewParams) {
		p.Graph.Connections = append(p.Graph.Connections, protocol.EffectConnection{From: "fx", To: "_input"})
	}} {
		bad := effectParams(e, 0, 4, 3, "ringmod", nil)
		bad.PreviewID = started.PreviewID
		change(&bad)
		rejected := effectRPCCall(t, e, protocol.MethodEffectsPreviewUpdate, bad, nil)
		if rejected.OK || e.effectsState.effectPreview != before {
			t.Fatal("rejected live graph update changed session", rejected)
		}
	}
	for _, method := range []string{protocol.MethodEditUndo, protocol.MethodSelectionSet, protocol.MethodDocumentOpen, protocol.MethodProcessStart} {
		if response := effectRPCCall(t, e, method, map[string]any{}, nil); response.OK {
			t.Fatal("preview allowed source/history mutation", method)
		}
	}
	updated := effectParams(e, 0, 4, 3, "ringmod", map[string]any{"carrierHz": 1000.0})
	updated.PreviewID = started.PreviewID
	response = effectRPCCall(t, e, protocol.MethodEffectsPreviewUpdate, updated, nil)
	if !response.OK || e.effectsState.effectPreview == before {
		t.Fatal("valid live update rejected", response)
	}
	stopped := effectRPCCall(t, e, protocol.MethodEffectsPreviewStop, protocol.EffectsSessionParams{DocumentID: p.DocumentID, PreviewID: started.PreviewID}, nil)
	if !stopped.OK || e.effectsState.effectPreview != nil {
		t.Fatal("stop retained resources", stopped)
	}
	if stale := effectRPCCall(t, e, protocol.MethodEffectsPreviewMeters, protocol.EffectsSessionParams{DocumentID: p.DocumentID, PreviewID: started.PreviewID}, nil); stale.OK {
		t.Fatal("closed session meter exposed")
	}
}

func TestEffectsLoopSeekAndBypassKeepActualDSPClock(t *testing.T) {
	input := make([]float32, 514)
	for frame := range input {
		input[frame] = .25
	}
	e, _ := openEditorFixture(t, input, 1)
	if _, err := e.configure(protocol.EngineConfigureParams{SampleRate: 48000, Channels: 1}); err != nil {
		t.Fatal(err)
	}
	p := effectParams(e, 7, 264, 1, "ringmod", map[string]any{"carrierHz": 750.0})
	started, err := e.startEffectPreview(protocol.MethodEffectsPreviewStart, p)
	if err != nil {
		t.Fatal(err)
	}
	end := p.End
	if _, err := e.playDocument(protocol.TransportPlayParams{Start: p.Start, End: &end, Loop: true, EffectPreviewID: started.PreviewID}); err != nil {
		t.Fatal(err)
	}
	output := make([]float32, 257*3)
	if n := e.Render(output); n != len(output) {
		t.Fatal("loop short read", n)
	}
	assertEditBits(t, output[:257], output[257:514])
	assertEditBits(t, output[:257], output[514:])
	stream := e.playback.transport.effects
	p.PreviewID = started.PreviewID
	p.Bypass = true
	if _, err := e.startEffectPreview(protocol.MethodEffectsPreviewUpdate, p); err != nil {
		t.Fatal(err)
	}
	if e.playback.transport.effects != stream {
		t.Fatal("bypass reset live chain state")
	}
	dry := make([]float32, 257)
	e.Render(dry)
	for _, value := range dry {
		if value != .25 {
			t.Fatal("bypass not dry", value)
		}
	}
	p.Bypass = false
	if _, err := e.startEffectPreview(protocol.MethodEffectsPreviewUpdate, p); err != nil {
		t.Fatal(err)
	}
	if _, err := e.seekDocument(protocol.TransportSeekParams{Frame: 7}); err != nil {
		t.Fatal(err)
	}
	fresh := make([]float32, 257)
	e.Render(fresh)
	assertEditBits(t, fresh, output[:257])
	if allocs := testing.AllocsPerRun(25, func() { e.Render(output) }); allocs != 0 {
		t.Fatalf("actual looping render allocates %g", allocs)
	}
}

func TestEffectsResponseBinaryAndIRTransferOwnership(t *testing.T) {
	e, _ := openEditorFixture(t, []float32{.5, .25, .1, 0}, 1)
	response := effectRPCCall(t, e, protocol.MethodEffectsResponse, protocol.EffectsResponseParams{EffectID: "filter-allpass", Points: 7}, nil)
	if !response.OK {
		t.Fatal(response.Error)
	}
	data := e.TakeData()
	if len(data) != 7*16 {
		t.Fatal("invalid response binary size")
	}
	for point := range 7 {
		hz := math.Float64frombits(binary.LittleEndian.Uint64(data[point*16:]))
		gain := math.Float64frombits(binary.LittleEndian.Uint64(data[point*16+8:]))
		if hz < 20 || hz > 20000.0001 || math.Abs(gain) > 1e-8 {
			t.Fatal("allpass magnitude is not unity", hz, gain)
		}
	}
	if bad := effectRPCCall(t, e, protocol.MethodEffectsResponse, protocol.EffectsResponseParams{EffectID: "ringmod"}, nil); bad.OK || len(e.TakeData()) != 0 {
		t.Fatal("nonlinear response/stalebinary exposed")
	}
	pcm := make([]byte, 12)
	for i, value := range []float32{1, .5, .25} {
		binary.LittleEndian.PutUint32(pcm[i*4:], math.Float32bits(value))
	}
	wav := rawWAV(3, 32, 1, 48000, pcm, false)
	loaded := effectRPCCall(t, e, protocol.MethodEffectsIRLoad, protocol.EffectsIRLoadParams{DocumentID: e.doc.editor.documentID, Name: "impulse.wav"}, wav)
	if !loaded.OK {
		t.Fatal(loaded.Error)
	}
	var info protocol.EffectsIRInfo
	if err := json.Unmarshal(loaded.Result, &info); err != nil {
		t.Fatal(err)
	}
	clear(wav)
	samples, rate, ok := e.ownedIRProvider().GetIR(info.IRID)
	if !ok || rate != 48000 || !reflect.DeepEqual(samples[0], []float64{1, .5, .25}) {
		t.Fatal("IR input storage retained or corrupted")
	}
	before := e.editResult(false)
	p := effectParams(e, 0, 4, 1, "reverb-conv", map[string]any{"irIndex": float64(info.IRID)})
	started, err := e.startEffectPreview(protocol.MethodEffectsPreviewStart, p)
	if err != nil {
		t.Fatal(err)
	}
	if removed := effectRPCCall(t, e, protocol.MethodEffectsIRRemove, protocol.EffectsIRRemoveParams{DocumentID: e.doc.editor.documentID, IRID: info.IRID}, nil); removed.OK {
		t.Fatal("removed active IR resource")
	}
	e.discardEffectPreview()
	if removed := effectRPCCall(t, e, protocol.MethodEffectsIRRemove, protocol.EffectsIRRemoveParams{DocumentID: e.doc.editor.documentID, IRID: info.IRID}, nil); !removed.OK || e.effectsState.impulseBytes != 0 {
		t.Fatal("IR release failed", removed)
	}
	if stale := effectRPCCall(t, e, protocol.MethodEffectsPreviewStart, p, nil); stale.OK {
		t.Fatal("convolution silently accepted missing IR", started)
	}
	if !reflect.DeepEqual(before, e.editResult(false)) {
		t.Fatal("IR lifetime changed source/history")
	}
	wrong := rawWAV(3, 32, 1, 44100, pcm, false)
	if rejected := effectRPCCall(t, e, protocol.MethodEffectsIRLoad, protocol.EffectsIRLoadParams{DocumentID: e.doc.editor.documentID}, wrong); rejected.OK {
		t.Fatal("mismatched IR rate accepted")
	}
}

func TestEffectsDynamicsTransferUsesActualStaticCompressor(t *testing.T) {
	e := New()
	response := effectRPCCall(t, e, protocol.MethodEffectsResponse, protocol.EffectsResponseParams{EffectID: "dyn-compressor", Mode: "transfer", Points: 9, Params: map[string]any{"thresholdDB": -20.0, "ratio": 2.0, "kneeDB": 0.0, "makeupGainDB": 0.0}}, nil)
	if !response.OK {
		t.Fatal(response.Error)
	}
	var info protocol.EffectsResponseInfo
	if err := json.Unmarshal(response.Result, &info); err != nil {
		t.Fatal(err)
	}
	if info.Axis != "level" || info.Count != 9 {
		t.Fatal("dynamics labelled frequency", info)
	}
	data := e.TakeData()
	if len(data) != 9*16 {
		t.Fatal("transfer payload")
	}
	for point := range 9 {
		input := math.Float64frombits(binary.LittleEndian.Uint64(data[point*16:]))
		output := math.Float64frombits(binary.LittleEndian.Uint64(data[point*16+8:]))
		want := input
		if input > -20 {
			want = -20 + (input+20)/2
		}
		if input != -80+10*float64(point) || math.Abs(output-want) > 1e-9 {
			t.Fatalf("static compressor transfer point%d got%g→%g want%g", point, input, output, want)
		}
	}
}

func TestEffectsConvolutionWetUpdateRetainsNonzeroTailAndRejectsAtomically(t *testing.T) {
	input := make([]float32, 3000)
	input[0] = 1
	e, _ := openEditorFixture(t, input, 1)
	if _, err := e.configure(protocol.EngineConfigureParams{SampleRate: 48000, Channels: 1}); err != nil {
		t.Fatal(err)
	}
	ir := make([]float64, 32769)
	ir[1024] = .5
	e.effectsState.impulseResponses = map[int]impulseResponse{1: {info: protocol.EffectsIRInfo{IRID: 1, SampleRate: 48000, Name: "tail", Channels: 1, Frames: int64(len(ir))}, ownerDocumentID: e.doc.editor.documentID, samples: [][]float64{ir}}}
	p := effectParams(e, 0, 3000, 1, "reverb-conv", map[string]any{"irIndex": 1, "wet": 1.0})
	preview, err := e.startEffectPreview(protocol.MethodEffectsPreviewStart, p)
	if err != nil {
		t.Fatal(err)
	}
	end := p.End
	if _, err := e.playDocument(protocol.TransportPlayParams{End: &end, EffectPreviewID: preview.PreviewID}); err != nil {
		t.Fatal(err)
	}
	if count := e.Render(make([]float32, 256)); count != 256 {
		t.Fatal("short initial convolution")
	}
	stream := e.playback.transport.effects
	session := e.effectsState.effectPreview
	p.PreviewID = preview.PreviewID
	p.Graph.Nodes[1].Params["wet"] = -1.0
	if _, err := e.startEffectPreview(protocol.MethodEffectsPreviewUpdate, p); err == nil || e.effectsState.effectPreview != session || e.playback.transport.effects != stream {
		t.Fatal("invalid wet changed prepared session")
	}
	p.Graph.Nodes[1].Params["wet"] = .25
	if _, err := e.startEffectPreview(protocol.MethodEffectsPreviewUpdate, p); err != nil {
		t.Fatal(err)
	}
	if e.playback.transport.effects != stream {
		t.Fatal("wet update rebuilt long impulse response")
	}
	tail := make([]float32, 1025-256)
	if count := e.Render(tail); count != len(tail) || tail[len(tail)-1] != .125 {
		t.Fatalf("updated nonzero IR tail count%d value%g", count, tail[len(tail)-1])
	}
	e.discardEffectPreview()
	p.PreviewID = ""
	fresh, err := e.startEffectPreview(protocol.MethodEffectsPreviewStart, p)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.playDocument(protocol.TransportPlayParams{End: &end, EffectPreviewID: fresh.PreviewID}); err != nil {
		t.Fatal(err)
	}
	reference := make([]float32, 3000)
	if count := e.Render(reference); count != len(reference) {
		t.Fatal("fresh preview short")
	}
	p.PreviewID = fresh.PreviewID
	started, err := e.applyEffects(p)
	if err != nil {
		t.Fatal(err)
	}
	finishEngineNormalization(t, e, started)
	candidate, _ := e.jobs.processJob.candidate.Channel(0)
	actual := make([]float32, 3000)
	candidate.Read(actual, 0)
	assertEditBits(t, actual, reference)
}

func TestEffectsPreparedStreamReuseInactiveUpdatesAndReplayReset(t *testing.T) {
	source := make([]float32, 2001)
	source[0], source[1024] = 1, .5
	e, _ := openEditorFixture(t, source, 1)
	if _, err := e.configure(protocol.EngineConfigureParams{SampleRate: 48000, Channels: 1}); err != nil {
		t.Fatal(err)
	}
	impulse := make([]float64, 32769)
	impulse[128] = .5
	e.effectsState.impulseResponses = map[int]impulseResponse{1: {info: protocol.EffectsIRInfo{IRID: 1, SampleRate: 48000}, samples: [][]float64{impulse}, ownerDocumentID: e.doc.editor.documentID}}
	p := effectParams(e, 0, 2001, 1, "reverb-conv", map[string]any{"irIndex": 1, "wet": 1.0})
	preview, err := e.startEffectPreview(protocol.MethodEffectsPreviewStart, p)
	if err != nil {
		t.Fatal(err)
	}
	prepared := e.effectsState.effectPreview.stream
	p.PreviewID = preview.PreviewID
	p.Graph.Nodes[1].Params["wet"] = .5
	wet := .5
	p.Wet = &wet
	if _, err := e.startEffectPreview(protocol.MethodEffectsPreviewUpdate, p); err != nil {
		t.Fatal(err)
	}
	if e.effectsState.effectPreview.stream != prepared {
		t.Fatal("inactive convolution update reconstructed its prepared IR")
	}
	end := p.End
	play := protocol.TransportPlayParams{End: &end, EffectPreviewID: preview.PreviewID}
	if _, err := e.playDocument(play); err != nil {
		t.Fatal(err)
	}
	if e.playback.transport.effects != prepared || e.effectsState.effectPreview.stream != prepared {
		t.Fatal("initial Play discarded prepared stream")
	}
	first := make([]float32, 1537)
	if count := e.Render(first); count != len(first) || first[128] != .125 {
		t.Fatalf("inactive controls not used count%d tail%g", count, first[128])
	}
	e.stopDocument()
	if _, err := e.playDocument(play); err != nil {
		t.Fatal(err)
	}
	if e.playback.transport.effects != prepared {
		t.Fatal("Stop/Play reconstructed convolution")
	}
	replay := make([]float32, len(first))
	e.Render(replay)
	assertEditBits(t, replay, first)
	if frames := e.effectMeters(e.effectsState.effectPreview).Frames; frames != 1664 {
		t.Fatalf("replay did not reset meter frames: %d", frames)
	}
	e.stopDocument()
	p.Bypass = true
	if _, err := e.startEffectPreview(protocol.MethodEffectsPreviewUpdate, p); err != nil {
		t.Fatal(err)
	}
	if e.effectsState.effectPreview.stream != prepared {
		t.Fatal("inactive bypass discarded prepared DSP")
	}
	if _, err := e.playDocument(play); err != nil {
		t.Fatal(err)
	}
	bypass := make([]float32, len(source))
	e.Render(bypass)
	assertEditBits(t, bypass, source)
}

func TestEffectsFailedActiveSeekOrPlayKeepsPreparedStateAtomic(t *testing.T) {
	source := make([]float32, 4096)
	for frame := range source {
		source[frame] = .125
	}
	source[3072] = math.MaxFloat32
	for _, command := range []string{"seek", "play"} {
		t.Run(command, func(t *testing.T) {
			e, _ := openEditorFixture(t, source, 1)
			if _, err := e.configure(protocol.EngineConfigureParams{SampleRate: 48000, Channels: 1}); err != nil {
				t.Fatal(err)
			}
			p := effectParams(e, 0, int64(len(source)), 1, "filter-peak", map[string]any{"gain": 24.0})
			preview, err := e.startEffectPreview(protocol.MethodEffectsPreviewStart, p)
			if err != nil {
				t.Fatal(err)
			}
			end := p.End
			if _, err := e.playDocument(protocol.TransportPlayParams{End: &end, EffectPreviewID: preview.PreviewID}); err != nil {
				t.Fatal(err)
			}
			prepared := e.effectsState.effectPreview.stream
			if count := e.Render(make([]float32, 257)); count != 257 {
				t.Fatal("initial safe playback failed")
			}
			transport := e.playback.transport
			position := transport.position
			if command == "seek" {
				_, err = e.seekDocument(protocol.TransportSeekParams{Frame: 3072})
			} else {
				_, err = e.playDocument(protocol.TransportPlayParams{Start: 3072, End: &end, EffectPreviewID: preview.PreviewID})
			}
			if err == nil {
				t.Fatal("finite overflow-producing lookahead unexpectedly accepted")
			}
			if e.playback.transport != transport || e.effectsState.effectPreview.stream != prepared || transport.effects != prepared || transport.position != position || !transport.playing {
				t.Fatal("failed private lookahead changed active transport or prepared state")
			}
			actual := make([]float32, 129)
			if count := e.Render(actual); count != len(actual) {
				t.Fatal("old playback lost after rejected lookahead")
			}
			fresh, _ := openEditorFixture(t, source, 1)
			if _, err := fresh.configure(protocol.EngineConfigureParams{SampleRate: 48000, Channels: 1}); err != nil {
				t.Fatal(err)
			}
			parameters := effectParams(fresh, 0, int64(len(source)), 1, "filter-peak", map[string]any{"gain": 24.0})
			referencePreview, err := fresh.startEffectPreview(protocol.MethodEffectsPreviewStart, parameters)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := fresh.playDocument(protocol.TransportPlayParams{End: &end, EffectPreviewID: referencePreview.PreviewID}); err != nil {
				t.Fatal(err)
			}
			reference := make([]float32, 257+len(actual))
			fresh.Render(reference)
			assertEditBits(t, actual, reference[257:])
		})
	}
}
