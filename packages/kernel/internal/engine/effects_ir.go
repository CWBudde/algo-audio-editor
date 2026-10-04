package engine

import (
	"fmt"
	"io"
	"math"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
	"github.com/cwbudde/wav"
	"github.com/go-audio/audio"
)

const (
	maxImpulseBytes   int64 = 32 << 20
	maxImpulseSeconds       = 30
)

type impulseResponse struct {
	info            protocol.EffectsIRInfo
	samples         [][]float64
	ownerDocumentID string
}
type impulseProvider map[int]impulseResponse

func (p impulseProvider) GetIR(index int) ([][]float64, float64, bool) {
	ir, ok := p[index]
	if !ok {
		return nil, 0, false
	}
	return ir.samples, float64(ir.info.SampleRate), true
}

func (e *Engine) ownedIRProvider() impulseProvider {
	provider := make(impulseProvider, len(e.impulseResponses))
	for id, ir := range e.impulseResponses {
		provider[id] = ir
	}
	return provider
}

func (e *Engine) loadImpulseResponse(p protocol.EffectsIRLoadParams, input []byte) (protocol.EffectsIRInfo, error) {
	const method = protocol.MethodEffectsIRLoad
	if err := e.validateDocumentID(method, p.DocumentID); err != nil {
		return protocol.EffectsIRInfo{}, err
	}
	layout, err := inspectWAV(input)
	if err != nil {
		return protocol.EffectsIRInfo{}, fmt.Errorf("%s: inspect WAV: %w", method, err)
	}
	frames := layout.dataBytes / (layout.channels * (layout.bitDepth / 8))
	if layout.rate != e.document.SampleRate() {
		return protocol.EffectsIRInfo{}, fmt.Errorf("%s: IR sample rate %d must match document sample rate %d", method, layout.rate, e.document.SampleRate())
	}
	if layout.channels > 2 || frames == 0 || frames > layout.rate*maxImpulseSeconds || int64(frames)*int64(layout.channels)*8 > maxImpulseBytes-e.impulseBytes {
		return protocol.EffectsIRInfo{}, fmt.Errorf("%s: IR requires nonempty mono/stereo audio, at most %d seconds and %d total owned bytes", method, maxImpulseSeconds, maxImpulseBytes)
	}
	if e.impulseSequence == math.MaxInt32 {
		return protocol.EffectsIRInfo{}, fmt.Errorf("%s: IR identity exhausted", method)
	}
	if err := e.checkStorage(method, int64(frames)*int64(layout.channels)*8+max(int64(len(input)), e.callInputBytes)); err != nil {
		return protocol.EffectsIRInfo{}, err
	}
	decoder := wav.NewDecoder(layout.reader(input))
	if err := decoder.FwdToPCM(); err != nil {
		return protocol.EffectsIRInfo{}, fmt.Errorf("%s: locate PCM: %w", method, err)
	}
	decoder.PCMChunk.R = io.LimitReader(decoder.PCMChunk.R, int64(layout.dataBytes))
	samples := make([][]float64, layout.channels)
	for channel := range samples {
		samples[channel] = make([]float64, frames)
	}
	const chunk = 4096
	pcm := &audio.Float32Buffer{Data: make([]float32, chunk*layout.channels)}
	for start := 0; start < frames; start += chunk {
		count := min(chunk, frames-start)
		pcm.Data = pcm.Data[:count*layout.channels]
		n, err := decoder.PCMBuffer(pcm)
		if err != nil || n != len(pcm.Data) {
			return protocol.EffectsIRInfo{}, fmt.Errorf("%s: incomplete PCM decode (%d/%d): %v", method, n, len(pcm.Data), err)
		}
		for frame := range count {
			for channel := range samples {
				value := pcm.Data[frame*layout.channels+channel]
				if math.Float32bits(value)&0x7f800000 == 0x7f800000 {
					return protocol.EffectsIRInfo{}, fmt.Errorf("%s: IR samples must be finite", method)
				}
				samples[channel][start+frame] = float64(value)
			}
		}
	}
	info := protocol.EffectsIRInfo{IRID: e.impulseSequence + 1, Name: p.Name, SampleRate: layout.rate, Channels: layout.channels, Frames: int64(frames)}
	if e.impulseResponses == nil {
		e.impulseResponses = make(map[int]impulseResponse)
	}
	e.impulseSequence++
	e.impulseResponses[info.IRID] = impulseResponse{info: info, samples: samples, ownerDocumentID: p.DocumentID}
	e.impulseBytes += int64(frames) * int64(layout.channels) * 8
	return info, nil
}

func (e *Engine) removeImpulseResponse(p protocol.EffectsIRRemoveParams) (protocol.EffectsIRRemoveResult, error) {
	if e.effectPreview != nil || e.processJob != nil {
		return protocol.EffectsIRRemoveResult{}, fmt.Errorf("effects.ir.remove: preview/processing owns IR resources")
	}
	ir, ok := e.impulseResponses[p.IRID]
	if !ok || p.DocumentID == "" || (p.DocumentID != e.editor.documentID && p.DocumentID != ir.ownerDocumentID) {
		return protocol.EffectsIRRemoveResult{}, fmt.Errorf("effects.ir.remove: stale IR identity")
	}
	delete(e.impulseResponses, p.IRID)
	e.impulseBytes -= ir.info.Frames * int64(ir.info.Channels) * 8
	return protocol.EffectsIRRemoveResult{Removed: true}, nil
}
