package engine

import (
	"fmt"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/effects"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

const transportBlockFrames = 2048

type renderSource uint8

const (
	sourceTone renderSource = iota
	sourceDocument
	sourceStopped
)

type documentTransport struct {
	start, end, position int64
	loop, playing        bool
	channels             []audiobuf.Channel
	mono                 []float32
	resampled            *documentResampler
	previewJobID         string
	effectPreviewID      string
	effects              *effects.Stream
	planar               [][]float64
}

func (t *documentTransport) result() protocol.TransportResult {
	return protocol.TransportResult{Start: t.start, End: t.end, Position: t.position, Loop: t.loop, Playing: t.playing}
}

func (e *Engine) playDocument(p protocol.TransportPlayParams) (protocol.TransportResult, error) {
	if p.PreviewJobID != "" && p.EffectPreviewID != "" {
		return protocol.TransportResult{}, fmt.Errorf("transport.play: only one preview source is permitted")
	}
	if p.EffectPreviewID != "" {
		if _, err := e.activeEffectSession("transport.play", protocol.EffectsSessionParams{DocumentID: e.editor.documentID, PreviewID: p.EffectPreviewID}); err != nil {
			return protocol.TransportResult{}, err
		}
	}
	document := e.document
	if p.PreviewJobID != "" {
		job := e.processJob
		if job == nil || job.result.JobID != p.PreviewJobID || job.result.State != "ready" {
			return protocol.TransportResult{}, fmt.Errorf("transport.play: preview job is not ready or is stale")
		}
		if err := e.validateProcessSource("transport.play", job); err != nil {
			return protocol.TransportResult{}, err
		}
		document = job.candidate
	} else if e.processJob != nil {
		return protocol.TransportResult{}, fmt.Errorf("transport.play: processing job is active")
	}
	if document.Channels() == 0 {
		return protocol.TransportResult{}, fmt.Errorf("transport.play: no document is open")
	}
	end := document.Frames()
	if p.End != nil {
		end = *p.End
	}
	if p.Start < 0 || p.Start >= end || end > document.Frames() || end > 1<<53-1 {
		return protocol.TransportResult{}, fmt.Errorf("transport.play: nonempty range [%d, %d) must be inside [0, %d)", p.Start, end, document.Frames())
	}
	t, err := e.makeTransportFromDocument(document, p.Start, end, p.Start, p.Loop, true)
	if err != nil {
		return protocol.TransportResult{}, fmt.Errorf("transport.play: prepare playback: %w", err)
	}
	t.previewJobID = p.PreviewJobID
	if p.EffectPreviewID != "" {
		if err := e.attachEffectPreview(t, p.EffectPreviewID); err != nil {
			return protocol.TransportResult{}, fmt.Errorf("transport.play: prepare effect preview: %w", err)
		}
	}
	e.transport, e.source = t, sourceDocument
	return t.result(), nil
}

func (e *Engine) attachEffectPreview(t *documentTransport, id string) error {
	session := e.effectPreview
	if session == nil || session.result.PreviewID != id {
		return fmt.Errorf("stale effect preview")
	}
	stream := session.stream
	if stream == nil {
		return fmt.Errorf("effect preview has no prepared stream")
	}
	// A playing stream must remain untouched if private lookahead preparation
	// fails. Initial Play and replay after Stop reuse the session's prepared DSP.
	if e.source == sourceDocument && e.transport != nil && e.transport.playing && e.transport.effects == stream {
		selection := session.result.SelectionRange
		var err error
		stream, err = effects.NewStream(e.document, ops.Range{Start: selection.Start, End: selection.End, ChannelMask: selection.ChannelMask}, session.config)
		if err != nil {
			return err
		}
	}
	if err := stream.Prime(t.position); err != nil {
		return fmt.Errorf("prepare effect lookahead: %w", err)
	}
	session.stream = stream
	t.effects = stream
	t.effectPreviewID = id
	t.planar = make([][]float64, len(t.channels))
	for channel := range t.planar {
		t.planar[channel] = make([]float64, transportBlockFrames)
	}
	return nil
}

func (e *Engine) makeTransport(start, end, position int64, loop, playing bool) (*documentTransport, error) {
	return e.makeTransportFromDocument(e.document, start, end, position, loop, playing)
}

func (e *Engine) makeTransportFromDocument(document audiobuf.Document, start, end, position int64, loop, playing bool) (*documentTransport, error) {
	if e.channels != document.Channels() {
		return nil, fmt.Errorf("render channels %d must match document channels %d", e.channels, document.Channels())
	}
	t := &documentTransport{
		start: start, end: end, position: position, loop: loop, playing: playing,
		channels: make([]audiobuf.Channel, e.channels), mono: make([]float32, transportBlockFrames),
	}
	for i := range t.channels {
		var err error
		t.channels[i], err = document.Channel(i)
		if err != nil {
			return nil, fmt.Errorf("read channel %d: %w", i, err)
		}
	}
	if playing && document.SampleRate() != int(e.sampleRate) {
		var err error
		t.resampled, err = newDocumentResampler(t, document.SampleRate(), int(e.sampleRate))
		if err != nil {
			return nil, fmt.Errorf("sample-rate conversion: %w", err)
		}
	}
	return t, nil
}

func (e *Engine) stopDocument() protocol.TransportResult {
	e.source = sourceStopped
	if e.transport == nil {
		return protocol.TransportResult{End: e.document.Frames()}
	}
	e.transport.playing = false
	return e.transport.result()
}

func (e *Engine) seekDocument(p protocol.TransportSeekParams) (protocol.TransportResult, error) {
	if e.processJob != nil {
		return protocol.TransportResult{}, fmt.Errorf("transport.seek: processing job is active")
	}
	if e.document.Channels() == 0 {
		return protocol.TransportResult{}, fmt.Errorf("transport.seek: no document is open")
	}
	if p.Frame < 0 || p.Frame > e.document.Frames() || p.Frame > 1<<53-1 {
		return protocol.TransportResult{}, fmt.Errorf("transport.seek: frame %d must be inside [0, %d]", p.Frame, e.document.Frames())
	}
	start, end, loop, playing := int64(0), e.document.Frames(), false, false
	if e.transport != nil {
		start, end, loop = e.transport.start, e.transport.end, e.transport.loop
		playing = e.source == sourceDocument && e.transport.playing
		if p.Frame < start || p.Frame > end {
			start, end = 0, e.document.Frames()
		}
	}
	if p.Frame == end {
		playing = false
	}
	// Paused seeks need no render workspace and are valid before configuration,
	// including the harmless cursor at frame zero of an empty document.
	var t *documentTransport
	if playing {
		var err error
		t, err = e.makeTransport(start, end, p.Frame, loop, true)
		if err != nil {
			return protocol.TransportResult{}, fmt.Errorf("transport.seek: prepare playback: %w", err)
		}
		if e.transport != nil && e.transport.effectPreviewID != "" {
			if err := e.attachEffectPreview(t, e.transport.effectPreviewID); err != nil {
				return protocol.TransportResult{}, fmt.Errorf("transport.seek: prepare effects: %w", err)
			}
		}
	} else {
		t = &documentTransport{start: start, end: end, position: p.Frame, loop: loop}
	}
	e.transport, e.source = t, sourceDocument
	return t.result(), nil
}

// RenderWithPositions renders interleaved audio and optional document cursor
// tags. Each tag describes the cursor after its corresponding output frame.
// The worklet publishes only consumed tags, so render-ahead never moves the
// visible cursor early. A short result marks EOF; unused whole frames are silent.
func (e *Engine) RenderWithPositions(dst []float32, positions []int64) int {
	if e.channels < 1 {
		clear(dst)
		clear(positions)
		return 0
	}
	frames := len(dst) / e.channels
	if positions != nil {
		frames = min(frames, len(positions))
		clear(positions[:frames])
	}
	output := dst[:frames*e.channels]
	clear(output)
	if frames == 0 || e.source == sourceStopped {
		return 0
	}
	if e.source == sourceTone {
		if e.tone == nil {
			return 0
		}
		e.tone.render(output, e.channels)
		return frames
	}
	t := e.transport
	if t == nil || !t.playing {
		return 0
	}
	if t.resampled != nil {
		return t.renderResampled(output, positions)
	}
	written := 0
	for written < frames && t.playing {
		count := int(min(int64(frames-written), int64(len(t.mono)), t.end-t.position))
		if t.effects != nil {
			for channel := range t.planar {
				t.planar[channel] = t.planar[channel][:count]
			}
			if err := t.effects.Read(t.planar, t.position); err != nil {
				t.playing = false
				break
			}
			for channel := range t.planar {
				selection := t.effects.Selection()
				needRaw := selection.ChannelMask&(1<<channel) == 0 || t.position < selection.Start || t.position+int64(count) > selection.End
				if needRaw {
					t.channels[channel].Read(t.mono[:count], t.position)
				}
				for frame := range count {
					value := float32(t.planar[channel][frame])
					position := t.position + int64(frame)
					if needRaw && (selection.ChannelMask&(1<<channel) == 0 || position < selection.Start || position >= selection.End) {
						value = t.mono[frame]
					}
					output[(written+frame)*e.channels+channel] = value
				}
			}
		} else {
			for channel, data := range t.channels {
				data.Read(t.mono[:count], t.position)
				for frame := range count {
					output[(written+frame)*e.channels+channel] = t.mono[frame]
				}
			}
		}
		for frame := range count {
			t.position++
			if t.position == t.end {
				if t.loop {
					t.position = t.start
					if t.effects != nil {
						if err := t.effects.Reset(t.start); err != nil {
							t.playing = false
						}
					}
				} else {
					t.playing = false
				}
			}
			if positions != nil {
				positions[written+frame] = t.position
			}
		}
		written += count
	}
	return written
}
