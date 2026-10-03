package engine

import (
	"fmt"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
	timestats "github.com/cwbudde/algo-dsp/stats/time"
)

const (
	maxEditorFrame = 1<<53 - 1
	maxSnapRadius  = 8192
	maxAnchors     = audiobuf.MaxAnchors
)

// Editor controls belong to an immutable history snapshot. Anchors are owned
// by document metadata; navigation restores both with a fresh document ID.
type editorState struct {
	documentID string
	selection  protocol.SelectionRange
}

func (e *Engine) dispatchEditor(method string, payload []byte) (any, error) {
	switch method {
	case protocol.MethodSelectionGet:
		var p protocol.SelectionGetParams
		if err := decode(method, payload, &p); err != nil {
			return nil, err
		}
		return e.getSelection(p)
	case protocol.MethodSelectionSet:
		var p protocol.SelectionSetParams
		if err := decode(method, payload, &p); err != nil {
			return nil, err
		}
		return e.setSelection(p)
	case protocol.MethodSelectionSnap:
		var p protocol.SelectionSnapParams
		if err := decode(method, payload, &p); err != nil {
			return nil, err
		}
		return e.snapSelection(p)
	case protocol.MethodTimelineGet:
		var p protocol.TimelineGetParams
		if err := decode(method, payload, &p); err != nil {
			return nil, err
		}
		return e.getTimeline(p)
	case protocol.MethodMarkersAdd:
		var p protocol.MarkerAddParams
		if err := decode(method, payload, &p); err != nil {
			return nil, err
		}
		return e.addMarker(p)
	case protocol.MethodRegionsAdd:
		var p protocol.RegionAddParams
		if err := decode(method, payload, &p); err != nil {
			return nil, err
		}
		return e.addRegion(p)
	case protocol.MethodMarkersUpdate:
		var p protocol.MarkerUpdateParams
		if err := decode(method, payload, &p); err != nil {
			return nil, err
		}
		return e.updateMarker(p)
	case protocol.MethodRegionsUpdate:
		var p protocol.RegionUpdateParams
		if err := decode(method, payload, &p); err != nil {
			return nil, err
		}
		return e.updateRegion(p)
	case protocol.MethodMarkersRemove, protocol.MethodRegionsRemove:
		var p protocol.TimelineRemoveParams
		if err := decode(method, payload, &p); err != nil {
			return nil, err
		}
		return e.removeAnchor(method, p)
	case protocol.MethodTimelineExport:
		var p protocol.TimelineExportParams
		if err := decode(method, payload, &p); err != nil {
			return nil, err
		}
		return e.exportTimeline(p)
	default:
		return nil, fmt.Errorf("unknown editor method %q", method)
	}
}

func (e *Engine) validateDocumentID(method, id string) error {
	if e.document.Channels() == 0 || e.editor.documentID == "" {
		return fmt.Errorf("%s: no document is open", method)
	}
	if id != e.editor.documentID {
		return fmt.Errorf("%s: stale or invalid document identity", method)
	}
	return nil
}

func (e *Engine) validateEditorRange(method string, start, end int64) error {
	if start < 0 || end < start || end > e.document.Frames() || end > maxEditorFrame {
		return fmt.Errorf("%s: range [%d, %d) must be within the JS-safe document frames [0, %d]", method, start, end, e.document.Frames())
	}
	return nil
}

func (e *Engine) validateChannelMask(method string, mask int) error {
	available := (1 << e.document.Channels()) - 1
	if mask <= 0 || mask&available != mask {
		return fmt.Errorf("%s: channel mask %d must be a positive subset of %d", method, mask, available)
	}
	return nil
}

func (e *Engine) selectionResult() protocol.SelectionResult {
	return protocol.SelectionResult{DocumentID: e.editor.documentID, SelectionRange: e.editor.selection}
}

func (e *Engine) getSelection(p protocol.SelectionGetParams) (protocol.SelectionResult, error) {
	if err := e.validateDocumentID(protocol.MethodSelectionGet, p.DocumentID); err != nil {
		return protocol.SelectionResult{}, err
	}
	return e.selectionResult(), nil
}

func (e *Engine) setSelection(p protocol.SelectionSetParams) (protocol.SelectionResult, error) {
	const method = protocol.MethodSelectionSet
	if err := e.validateDocumentID(method, p.DocumentID); err != nil {
		return protocol.SelectionResult{}, err
	}
	if err := e.validateEditorRange(method, p.Start, p.End); err != nil {
		return protocol.SelectionResult{}, err
	}
	if err := e.validateChannelMask(method, p.ChannelMask); err != nil {
		return protocol.SelectionResult{}, err
	}
	e.editor.selection = p.SelectionRange
	return e.selectionResult(), nil
}

func (e *Engine) snapSelection(p protocol.SelectionSnapParams) (protocol.SelectionSnapResult, error) {
	const method = protocol.MethodSelectionSnap
	if err := e.validateDocumentID(method, p.DocumentID); err != nil {
		return protocol.SelectionSnapResult{}, err
	}
	if err := e.validateEditorRange(method, p.Frame, p.Frame); err != nil {
		return protocol.SelectionSnapResult{}, err
	}
	if err := e.validateChannelMask(method, p.ChannelMask); err != nil {
		return protocol.SelectionSnapResult{}, err
	}
	if p.Radius < 0 || p.Radius > maxSnapRadius {
		return protocol.SelectionSnapResult{}, fmt.Errorf("%s: radius %d must be in [0, %d]", method, p.Radius, maxSnapRadius)
	}
	result := protocol.SelectionSnapResult{DocumentID: p.DocumentID, Frame: p.Frame}
	// The extra predecessor detects a crossing exactly at the left radius
	// boundary. At most 2*radius+2 samples are copied, one channel at a time.
	start := max(int64(0), p.Frame-p.Radius-1)
	end := min(e.document.Frames(), p.Frame+p.Radius+1)
	if start == end {
		return result, nil
	}
	window := make([]float32, int(end-start))
	bestDistance := p.Radius + 1
	for channel := range e.document.Channels() {
		if p.ChannelMask&(1<<channel) == 0 {
			continue
		}
		source, err := e.document.Channel(channel)
		if err != nil {
			return protocol.SelectionSnapResult{}, fmt.Errorf("%s: channel %d: %w", method, channel, err)
		}
		if n := source.Read(window, start); n != len(window) {
			return protocol.SelectionSnapResult{}, fmt.Errorf("%s: channel %d read %d of %d frames", method, channel, n, len(window))
		}
		index, found := timestats.NearestZeroCrossing(window, int(p.Frame-start), int(p.Radius))
		if !found {
			continue
		}
		frame := start + int64(index)
		distance := frame - p.Frame
		if distance < 0 {
			distance = -distance
		}
		if distance < bestDistance || (distance == bestDistance && frame < result.Frame) {
			result.Frame, result.Found, bestDistance = frame, true, distance
		}
	}
	return result, nil
}

func (e *Engine) timelineResult() protocol.TimelineResult {
	timeline := e.document.Metadata().Timeline
	result := protocol.TimelineResult{
		DocumentID: e.editor.documentID,
		Markers:    make([]protocol.TimelineMarker, len(timeline.Markers)),
		Regions:    make([]protocol.TimelineRegion, len(timeline.Regions)),
	}
	for i, marker := range timeline.Markers {
		result.Markers[i] = protocol.TimelineMarker{ID: marker.ID, Frame: marker.Frame, Name: marker.Name, Color: marker.Color}
	}
	for i, region := range timeline.Regions {
		result.Regions[i] = protocol.TimelineRegion{ID: region.ID, Start: region.Start, End: region.End, Name: region.Name, Color: region.Color}
	}
	return result
}

func (e *Engine) getTimeline(p protocol.TimelineGetParams) (protocol.TimelineResult, error) {
	if err := e.validateDocumentID(protocol.MethodTimelineGet, p.DocumentID); err != nil {
		return protocol.TimelineResult{}, err
	}
	return e.timelineResult(), nil
}
