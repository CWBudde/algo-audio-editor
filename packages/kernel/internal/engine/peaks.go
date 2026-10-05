package engine

import (
	"fmt"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func (e *Engine) getPeaks(p protocol.PeaksGetParams) (protocol.PeaksGetInfo, error) {
	if e.doc.document.Channels() == 0 {
		return protocol.PeaksGetInfo{}, fmt.Errorf("%s: no document is open", protocol.MethodPeaksGet)
	}
	channel, err := e.doc.document.Channel(p.Channel)
	if err != nil {
		return protocol.PeaksGetInfo{}, fmt.Errorf("%s: %w", protocol.MethodPeaksGet, err)
	}
	peaks, err := channel.Peaks(p.StartFrame, p.EndFrame, p.Buckets)
	if err != nil {
		return protocol.PeaksGetInfo{}, fmt.Errorf("%s: %w", protocol.MethodPeaksGet, err)
	}
	e.bulkData = peaks.Data

	return protocol.PeaksGetInfo{
		FramesPerBucket: peaks.FramesPerBucket, Count: peaks.Count, DataBytes: len(peaks.Data),
	}, nil
}
