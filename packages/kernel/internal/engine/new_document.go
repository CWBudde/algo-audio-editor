package engine

import (
	"fmt"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

// newDocument replaces the document with clean silence. Every channel shares
// immutable zero blocks, so even long durations cost block references, not
// sample storage. Like a generated document it has no source container and is
// stored as 32-bit float.
func (e *Engine) newDocument(p protocol.DocumentNewParams) (protocol.DocumentInfoResult, error) {
	const method = protocol.MethodDocumentNew
	if p.SampleRate < MinSampleRate || p.SampleRate > MaxSampleRate || p.Channels < 1 || p.Channels > MaxChannels {
		return protocol.DocumentInfoResult{}, fmt.Errorf("%s: sample rate must be in [%d, %d] Hz and channels in [1, %d]", method, MinSampleRate, MaxSampleRate, MaxChannels)
	}
	if p.Frames < 0 || p.Frames > maxEditorFrame {
		return protocol.DocumentInfoResult{}, fmt.Errorf("%s: length must be nonnegative and JS-safe", method)
	}
	// A partial tail block per channel plus one reference per block, as for
	// inserted silence.
	extra := decodedStorage(min(p.Frames, 2*audiobuf.BlockFrames), p.Channels, audiobuf.BlockFrames)
	extra += (p.Frames/audiobuf.BlockFrames + 1) * int64(p.Channels) * 32
	if err := e.checkStorage(method, extra); err != nil {
		return protocol.DocumentInfoResult{}, err
	}
	channels := make([]audiobuf.Channel, p.Channels)
	for i := range channels {
		var err error
		if channels[i], err = audiobuf.NewSilence(p.Frames); err != nil {
			return protocol.DocumentInfoResult{}, fmt.Errorf("%s: %w", method, err)
		}
	}
	name := p.Name
	if name == "" {
		name = "Untitled"
	}
	document, err := audiobuf.NewDocument(channels, p.SampleRate, audiobuf.Metadata{Name: name})
	if err != nil {
		return protocol.DocumentInfoResult{}, fmt.Errorf("%s: document: %w", method, err)
	}
	return e.installDocument(document, 32, true, "")
}
