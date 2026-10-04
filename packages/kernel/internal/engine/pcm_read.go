package engine

import (
	"encoding/binary"
	"fmt"
	"math"
	"math/bits"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

// readPCM copies source samples only, without transport effects or resampling.
// Identity/history guards keep successive pages from mixing different edits.
func (e *Engine) readPCM(p protocol.PCMReadParams) (protocol.PCMReadInfo, error) {
	const method = protocol.MethodDocumentReadPCM
	if err := e.validateDocumentID(method, p.DocumentID); err != nil {
		return protocol.PCMReadInfo{}, err
	}
	if e.history == nil || p.StateID == "" || p.StateID != e.history.CurrentID() {
		return protocol.PCMReadInfo{}, fmt.Errorf("%s: stale or invalid history state", method)
	}
	if p.Frames < 1 || p.Frames > 8192 || p.Start < 0 || p.Start > e.document.Frames()-int64(p.Frames) {
		return protocol.PCMReadInfo{}, fmt.Errorf("%s: invalid page range (1–8192 frames required)", method)
	}
	if err := e.validateChannelMask(method, p.ChannelMask); err != nil {
		return protocol.PCMReadInfo{}, err
	}
	channels := bits.OnesCount(uint(p.ChannelMask))
	data := make([]byte, p.Frames*channels*4)
	scratch := make([]float32, p.Frames)
	packed := 0
	for channel := range e.document.Channels() {
		if p.ChannelMask&(1<<channel) == 0 {
			continue
		}
		source, _ := e.document.Channel(channel)
		if source.Read(scratch, p.Start) != p.Frames {
			return protocol.PCMReadInfo{}, fmt.Errorf("%s: incomplete source read", method)
		}
		for i, value := range scratch {
			if math.IsNaN(float64(value)) || math.IsInf(float64(value), 0) {
				return protocol.PCMReadInfo{}, fmt.Errorf("%s: browser encoding requires finite samples", method)
			}
			binary.LittleEndian.PutUint32(data[(packed*p.Frames+i)*4:], math.Float32bits(value))
		}
		packed++
	}
	e.bulkData = data
	return protocol.PCMReadInfo{SampleRate: e.document.SampleRate(), Channels: channels, Frames: p.Frames, DataBytes: len(data)}, nil
}
