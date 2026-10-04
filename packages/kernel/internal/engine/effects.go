package engine

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/effects"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	processing "github.com/cwbudde/algo-audio-editor/packages/kernel/internal/process"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
	"github.com/cwbudde/algo-dsp/dsp/effectchain"
)

type effectPreviewSession struct {
	result       protocol.EffectsPreviewResult
	config       effects.Config
	stream       *effects.Stream
	historyState string
}

func (e *Engine) guardEffects(method string) error {
	if e.effectPreview == nil {
		return nil
	}
	switch method {
	case protocol.MethodHello, protocol.MethodDocumentMemory, protocol.MethodDocumentInfo, protocol.MethodDocumentExport,
		protocol.MethodEditState, protocol.MethodPreparePaste, protocol.MethodHistoryList, protocol.MethodSelectionGet,
		protocol.MethodSelectionSnap, protocol.MethodTimelineGet, protocol.MethodTimelineExport, protocol.MethodPeaksGet,
		protocol.MethodEngineConfigure, protocol.MethodTransportPlay, protocol.MethodTransportStop, protocol.MethodTransportSeek,
		protocol.MethodEffectsList, protocol.MethodEffectsResponse, protocol.MethodEffectsPreviewUpdate, protocol.MethodEffectsPreviewStop,
		protocol.MethodEffectsPreviewMeters, protocol.MethodEffectsApply, protocol.MethodEffectsIRLoad:
		return nil
	case protocol.MethodMetersConfigure, protocol.MethodAnalysisStart, protocol.MethodAnalysisStep, protocol.MethodAnalysisCancel, protocol.MethodAnalysisSpectrum:
		return nil
	default:
		return fmt.Errorf("%s: effect preview is active", method)
	}
}

func (e *Engine) dispatchEffects(method string, payload, input []byte) (any, error) {
	switch method {
	case protocol.MethodEffectsList:
		var p protocol.EffectsListParams
		if err := decode(method, payload, &p); err != nil {
			return nil, err
		}
		rate, err := e.effectsRate(p.SampleRate)
		if err != nil {
			return nil, err
		}
		descriptors, err := effects.Descriptors(rate)
		return protocol.EffectsListResult{Effects: descriptors}, err
	case protocol.MethodEffectsResponse:
		var p protocol.EffectsResponseParams
		if err := decode(method, payload, &p); err != nil {
			return nil, err
		}
		return e.effectResponse(p)
	case protocol.MethodEffectsPreviewStart, protocol.MethodEffectsPreviewUpdate, protocol.MethodEffectsApply:
		var p protocol.EffectsPreviewParams
		if err := decode(method, payload, &p); err != nil {
			return nil, err
		}
		if method == protocol.MethodEffectsApply {
			return e.applyEffects(p)
		}
		return e.startEffectPreview(method, p)
	case protocol.MethodEffectsPreviewStop, protocol.MethodEffectsPreviewMeters:
		var p protocol.EffectsSessionParams
		if err := decode(method, payload, &p); err != nil {
			return nil, err
		}
		session, err := e.activeEffectSession(method, p)
		if err != nil {
			return nil, err
		}
		if method == protocol.MethodEffectsPreviewStop {
			e.discardEffectPreview()
			return protocol.EffectsStopResult{Stopped: true}, nil
		}
		return e.effectMeters(session), nil
	case protocol.MethodEffectsIRLoad:
		var p protocol.EffectsIRLoadParams
		if err := decode(method, payload, &p); err != nil {
			return nil, err
		}
		return e.loadImpulseResponse(p, input)
	case protocol.MethodEffectsIRRemove:
		var p protocol.EffectsIRRemoveParams
		if err := decode(method, payload, &p); err != nil {
			return nil, err
		}
		return e.removeImpulseResponse(p)
	default:
		return nil, fmt.Errorf("%s: unknown effect method", method)
	}
}

func (e *Engine) effectsRate(rate float64) (float64, error) {
	if rate == 0 {
		rate = e.sampleRate
		if e.document.Channels() > 0 {
			rate = float64(e.document.SampleRate())
		}
	}
	if math.IsNaN(rate) || math.IsInf(rate, 0) || rate != math.Trunc(rate) || rate < MinSampleRate || rate > MaxSampleRate {
		return 0, fmt.Errorf("effects: sample rate must be an integer in [%d,%d]", MinSampleRate, MaxSampleRate)
	}
	return rate, nil
}

func (e *Engine) prepareEffects(method string, p protocol.EffectsPreviewParams) (effects.Config, protocol.SelectionRange, error) {
	if err := e.validateDocumentID(method, p.DocumentID); err != nil {
		return effects.Config{}, protocol.SelectionRange{}, err
	}
	if err := e.validateEditorRange(method, p.Start, p.End); err != nil {
		return effects.Config{}, protocol.SelectionRange{}, err
	}
	if err := e.validateChannelMask(method, p.ChannelMask); err != nil {
		return effects.Config{}, protocol.SelectionRange{}, err
	}
	selection := p.SelectionRange
	if selection.Start == selection.End {
		selection.Start = 0
		selection.End = e.document.Frames()
	}
	wet := 1.0
	if p.Wet != nil {
		wet = *p.Wet
	}
	var config effects.Config
	var err error
	selected := ops.Range{Start: selection.Start, End: selection.End, ChannelMask: selection.ChannelMask}
	if e.effectPreview != nil && e.effectPreview.result.SelectionRange == selection {
		config, err = effects.NewUpdatedConfig(e.effectPreview.config, e.document, selected, p.Graph, wet, p.Bypass, e.ownedIRProvider())
	} else {
		config, err = effects.NewConfig(e.document, selected, p.Graph, wet, p.Bypass, e.ownedIRProvider())
	}
	if err != nil {
		return effects.Config{}, selection, fmt.Errorf("%s: %w", method, err)
	}
	return config, selection, nil
}

func (e *Engine) activeEffectSession(method string, p protocol.EffectsSessionParams) (*effectPreviewSession, error) {
	if err := e.validateDocumentID(method, p.DocumentID); err != nil {
		return nil, err
	}
	session := e.effectPreview
	if session == nil || p.PreviewID == "" || p.PreviewID != session.result.PreviewID || e.history == nil || e.history.CurrentID() != session.historyState {
		return nil, fmt.Errorf("%s: stale effect preview", method)
	}
	return session, nil
}

func (e *Engine) startEffectPreview(method string, p protocol.EffectsPreviewParams) (protocol.EffectsPreviewResult, error) {
	if e.processJob != nil {
		return protocol.EffectsPreviewResult{}, fmt.Errorf("%s: processing job is active", method)
	}
	if method == protocol.MethodEffectsPreviewUpdate {
		if _, err := e.activeEffectSession(method, protocol.EffectsSessionParams{DocumentID: p.DocumentID, PreviewID: p.PreviewID}); err != nil {
			return protocol.EffectsPreviewResult{}, err
		}
	} else if e.effectPreview != nil {
		return protocol.EffectsPreviewResult{}, fmt.Errorf("%s: preview is already active", method)
	}
	config, selection, err := e.prepareEffects(method, p)
	if err != nil {
		return protocol.EffectsPreviewResult{}, err
	}
	selected := ops.Range{Start: selection.Start, End: selection.End, ChannelMask: selection.ChannelMask}
	// Preparing a replacement completely first keeps rejected live updates
	// atomic. No old runtime or document state has been changed at this point.
	var stream *effects.Stream
	mixOnly := e.effectPreview != nil && e.effectPreview.config.Graph == config.Graph && e.effectPreview.result.SelectionRange == selection
	inPlace := false
	if mixOnly {
		stream = e.effectPreview.stream
	}
	if !mixOnly && method == protocol.MethodEffectsPreviewUpdate && e.effectPreview.result.SelectionRange == selection {
		inPlace, err = e.effectPreview.stream.TryUpdate(config)
		if err != nil {
			return protocol.EffectsPreviewResult{}, fmt.Errorf("%s: %w", method, err)
		}
		if inPlace {
			stream = e.effectPreview.stream
		}
	}
	if !mixOnly && !inPlace {
		stream, err = effects.NewStream(e.document, selected, config)
		if err != nil {
			return protocol.EffectsPreviewResult{}, fmt.Errorf("%s: %w", method, err)
		}
		if method == protocol.MethodEffectsPreviewUpdate && e.transport != nil && e.transport.effectPreviewID == p.PreviewID {
			frame := e.transport.position
			if e.transport.resampled != nil {
				frame = e.transport.resampled.readFrame
			}
			if err := stream.Prime(frame); err != nil {
				return protocol.EffectsPreviewResult{}, fmt.Errorf("%s: prepare output: %w", method, err)
			}
		}
	}
	id := p.PreviewID
	if method == protocol.MethodEffectsPreviewStart {
		if e.effectSequence == math.MaxUint64 {
			return protocol.EffectsPreviewResult{}, fmt.Errorf("%s: preview identity exhausted", method)
		}
		e.effectSequence++
		id = fmt.Sprintf("effect-%d", e.effectSequence)
	}
	result := protocol.EffectsPreviewResult{SelectionResult: protocol.SelectionResult{DocumentID: p.DocumentID, SelectionRange: selection}, PreviewID: id, Wet: config.Wet, Bypass: config.Bypass}
	if mixOnly {
		stream.SetMix(config.Wet, config.Bypass)
	}
	e.effectPreview = &effectPreviewSession{result: result, config: config, stream: stream, historyState: e.history.CurrentID()}
	if e.transport != nil && e.transport.effectPreviewID == id {
		e.transport.effects = stream
	}
	return result, nil
}

func encodeGraph(graph protocol.EffectGraph) (string, error) {
	encoded, err := json.Marshal(graph)
	if err != nil {
		return "", fmt.Errorf("effects.graph: encode: %w", err)
	}
	return string(encoded), nil
}

func (e *Engine) discardEffectPreview() {
	if e.effectPreview != nil && e.transport != nil && e.transport.effectPreviewID == e.effectPreview.result.PreviewID {
		e.transport = nil
		e.source = sourceStopped
	}
	e.effectPreview = nil
}

func (e *Engine) effectMeters(session *effectPreviewSession) protocol.EffectsMetersResult {
	result := protocol.EffectsMetersResult{DocumentID: session.result.DocumentID, PreviewID: session.result.PreviewID, InputPeak: make([]float64, e.document.Channels()), InputRMS: make([]float64, e.document.Channels()), OutputPeak: make([]float64, e.document.Channels()), OutputRMS: make([]float64, e.document.Channels())}
	if e.transport != nil && e.transport.effectPreviewID == session.result.PreviewID && e.transport.effects != nil {
		meter := e.transport.effects.Meters()
		result.Frames = meter.Frames
		copy(result.InputPeak, meter.InputPeak)
		copy(result.InputRMS, meter.InputRMS)
		copy(result.OutputPeak, meter.OutputPeak)
		copy(result.OutputRMS, meter.OutputRMS)
	}
	return result
}

func (e *Engine) applyEffects(p protocol.EffectsPreviewParams) (protocol.ProcessJobResult, error) {
	const method = protocol.MethodEffectsApply
	if e.processJob != nil {
		return protocol.ProcessJobResult{}, fmt.Errorf("%s: processing job is active", method)
	}
	if p.PreviewID != "" {
		if _, err := e.activeEffectSession(method, protocol.EffectsSessionParams{DocumentID: p.DocumentID, PreviewID: p.PreviewID}); err != nil {
			return protocol.ProcessJobResult{}, err
		}
	}
	config, selection, err := e.prepareEffects(method, p)
	if err != nil {
		return protocol.ProcessJobResult{}, err
	}
	if e.processSequence == math.MaxUint64 || e.history == nil {
		return protocol.ProcessJobResult{}, fmt.Errorf("%s: history/job identity is unavailable", method)
	}
	job, err := effects.NewJob(e.document, ops.Range{Start: selection.Start, End: selection.End, ChannelMask: selection.ChannelMask}, config, processing.Limits{MaxOutputBytes: maxProcessOutputBytes})
	if err != nil {
		return protocol.ProcessJobResult{}, fmt.Errorf("%s: %w", method, err)
	}
	before := cloneEditor(e.editor)
	before.selection = p.SelectionRange
	e.discardEffectPreview()
	e.processSequence++
	e.processJob = &processingJob{result: protocol.ProcessJobResult{SelectionResult: protocol.SelectionResult{DocumentID: p.DocumentID, SelectionRange: selection}, JobID: fmt.Sprintf("process-%d", e.processSequence), State: "running", Operation: "effects", TotalFrames: selection.End - selection.Start, Phase: "processing", PhaseCount: 1, GainResolved: true}, builder: job, before: historySnapshot{document: e.document, editor: before}, historyState: e.history.CurrentID()}
	e.refreshProcessStatus(e.processJob)
	return e.processJob.result, nil
}

func (e *Engine) effectResponse(p protocol.EffectsResponseParams) (protocol.EffectsResponseInfo, error) {
	if p.Mode != "" && p.Mode != "frequency" && p.Mode != "transfer" {
		return protocol.EffectsResponseInfo{}, fmt.Errorf("effects.response: unknown mode %q", p.Mode)
	}
	rate, err := e.effectsRate(p.SampleRate)
	if err != nil {
		return protocol.EffectsResponseInfo{}, err
	}
	points := p.Points
	if points == 0 {
		points = 256
	}
	if points < 2 || points > 2048 {
		return protocol.EffectsResponseInfo{}, fmt.Errorf("effects.response: points must be in [2,2048]")
	}
	graph := p.Graph
	if graph == nil {
		graph = &protocol.EffectGraph{Nodes: []protocol.EffectNode{{ID: "_input", Type: "_input"}, {ID: "fx", Type: p.EffectID, Params: p.Params}, {ID: "_output", Type: "_output"}}, Connections: []protocol.EffectConnection{{From: "_input", To: "fx"}, {From: "fx", To: "_output"}}}
	}
	descriptors, err := effects.Descriptors(rate)
	if err != nil {
		return protocol.EffectsResponseInfo{}, err
	}
	// Graph validation uses an empty IR provider and a complete stereo mask;
	// upstream response rejects any non-EQ/filter graph independently.
	if err := effects.ValidateResponseGraph(*graph, descriptors, int(rate)); err != nil {
		return protocol.EffectsResponseInfo{}, fmt.Errorf("effects.response: %w", err)
	}
	encoded, err := encodeGraph(*graph)
	if err != nil {
		return protocol.EffectsResponseInfo{}, err
	}
	chain := effectchain.New(effectchain.Context{SampleRate: rate}, effectchain.DefaultRegistry())
	if err := chain.LoadGraph(encoded); err != nil {
		return protocol.EffectsResponseInfo{}, err
	}
	frequencies := make([]float64, points)
	maxHz := math.Min(20000, rate*.49)
	ratio := maxHz / 20
	for i := range frequencies {
		frequencies[i] = 20 * math.Pow(ratio, float64(i)/float64(points-1))
		if p.Mode == "transfer" {
			frequencies[i] = -80 + 80*float64(i)/float64(points-1)
		}
	}
	var magnitudes []float64
	if p.Mode == "transfer" {
		magnitudes, err = chain.Transfer(frequencies)
	} else {
		magnitudes, err = chain.Response(frequencies)
	}
	if err != nil {
		return protocol.EffectsResponseInfo{}, fmt.Errorf("effects.response: %w", err)
	}
	if len(magnitudes) != points {
		return protocol.EffectsResponseInfo{}, fmt.Errorf("effects.response: invalid upstream response length")
	}
	data := make([]byte, points*16)
	for i, gain := range magnitudes {
		if math.IsNaN(gain) || math.IsInf(gain, 0) || (p.Mode != "transfer" && gain < 0) {
			return protocol.EffectsResponseInfo{}, fmt.Errorf("effects.response: unsafe magnitude")
		}
		db := 20 * math.Log10(math.Max(gain, 1e-15))
		if p.Mode == "transfer" {
			db = gain
		}
		binary.LittleEndian.PutUint64(data[i*16:], math.Float64bits(frequencies[i]))
		binary.LittleEndian.PutUint64(data[i*16+8:], math.Float64bits(db))
	}
	e.bulkData = data
	axis := "frequency"
	if p.Mode == "transfer" {
		axis = "level"
	}
	return protocol.EffectsResponseInfo{Axis: axis, Count: points, DataBytes: len(data)}, nil
}
