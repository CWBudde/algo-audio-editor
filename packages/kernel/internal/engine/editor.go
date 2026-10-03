package engine

import (
	"fmt"
	"math"
	"strings"
	"unicode/utf8"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
	timestats "github.com/cwbudde/algo-dsp/stats/time"
)

const (
	maxEditorFrame = 1<<53 - 1
	maxSnapRadius  = 8192
	maxAnchors     = 4096
	maxAnchorName  = 256
)

// Editor state belongs to an immutable audio-history snapshot. Navigation
// restores selection and anchors while assigning a fresh document identity.
// Edit-aware anchor shifting and persistence are later foundations.
type editorState struct {
	documentID     string
	selection      protocol.SelectionRange
	markers        []protocol.TimelineMarker
	regions        []protocol.TimelineRegion
	anchorSequence int
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
	result := protocol.TimelineResult{
		DocumentID: e.editor.documentID,
		Markers:    make([]protocol.TimelineMarker, len(e.editor.markers)),
		Regions:    make([]protocol.TimelineRegion, len(e.editor.regions)),
	}
	copy(result.Markers, e.editor.markers)
	copy(result.Regions, e.editor.regions)
	return result
}

func (e *Engine) getTimeline(p protocol.TimelineGetParams) (protocol.TimelineResult, error) {
	if err := e.validateDocumentID(protocol.MethodTimelineGet, p.DocumentID); err != nil {
		return protocol.TimelineResult{}, err
	}
	return e.timelineResult(), nil
}

func (e *Engine) anchorName(method, name, kind string) (string, int, error) {
	if len(e.editor.markers)+len(e.editor.regions) >= maxAnchors {
		return "", 0, fmt.Errorf("%s: document already contains %d anchors", method, maxAnchors)
	}
	sequence := e.editor.anchorSequence
	for _, marker := range e.editor.markers {
		sequence = max(sequence, marker.ID)
	}
	for _, region := range e.editor.regions {
		sequence = max(sequence, region.ID)
	}
	if sequence == math.MaxInt {
		return "", 0, fmt.Errorf("%s: anchor identity exhausted", method)
	}
	id := sequence + 1
	name = strings.TrimSpace(name)
	if len(name) > maxAnchorName || !utf8.ValidString(name) {
		return "", 0, fmt.Errorf("%s: name must be valid UTF-8 and at most %d bytes", method, maxAnchorName)
	}
	if name == "" {
		name = fmt.Sprintf("%s %d", kind, id)
	}
	return name, id, nil
}

func (e *Engine) addMarker(p protocol.MarkerAddParams) (protocol.TimelineResult, error) {
	const method = protocol.MethodMarkersAdd
	if err := e.validateDocumentID(method, p.DocumentID); err != nil {
		return protocol.TimelineResult{}, err
	}
	if err := e.validateEditorRange(method, p.Frame, p.Frame); err != nil {
		return protocol.TimelineResult{}, err
	}
	name, id, err := e.anchorName(method, p.Name, "Marker")
	if err != nil {
		return protocol.TimelineResult{}, err
	}
	e.editor.markers = append(e.editor.markers, protocol.TimelineMarker{ID: id, Frame: p.Frame, Name: name})
	e.editor.anchorSequence = id
	return e.timelineResult(), nil
}

func (e *Engine) addRegion(p protocol.RegionAddParams) (protocol.TimelineResult, error) {
	const method = protocol.MethodRegionsAdd
	if err := e.validateDocumentID(method, p.DocumentID); err != nil {
		return protocol.TimelineResult{}, err
	}
	if err := e.validateEditorRange(method, p.Start, p.End); err != nil {
		return protocol.TimelineResult{}, err
	}
	if p.Start == p.End {
		return protocol.TimelineResult{}, fmt.Errorf("%s: region must be nonempty", method)
	}
	name, id, err := e.anchorName(method, p.Name, "Region")
	if err != nil {
		return protocol.TimelineResult{}, err
	}
	e.editor.regions = append(e.editor.regions, protocol.TimelineRegion{ID: id, Start: p.Start, End: p.End, Name: name})
	e.editor.anchorSequence = id
	return e.timelineResult(), nil
}
