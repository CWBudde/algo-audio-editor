package engine

import (
	"fmt"
	"slices"
	"strings"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func anchorFields(kind string, id int64, name, color string, adding bool) (string, string, error) {
	name = strings.TrimSpace(name)
	if name == "" && adding {
		name = fmt.Sprintf("%s %d", kind, id)
	}
	if err := audiobuf.ValidateAnchorName(name); err != nil {
		return "", "", err
	}
	color = strings.ToLower(strings.TrimSpace(color))
	if color == "" {
		color = audiobuf.DefaultAnchorColor
	}
	if err := audiobuf.ValidateAnchorColor(color); err != nil {
		return "", "", err
	}
	return name, color, nil
}

func (e *Engine) timelineControls(method, id string, selection *protocol.SelectionRange) (editorState, error) {
	if err := e.validateDocumentID(method, id); err != nil {
		return editorState{}, err
	}
	editor := e.editor
	if selection != nil {
		if err := e.validateEditorRange(method, selection.Start, selection.End); err != nil {
			return editorState{}, err
		}
		if err := e.validateChannelMask(method, selection.ChannelMask); err != nil {
			return editorState{}, err
		}
		editor.selection = *selection
	}
	return editor, nil
}

func (e *Engine) timelineMutationResult(changed bool) protocol.TimelineMutationResult {
	return protocol.TimelineMutationResult{TimelineResult: e.timelineResult(), History: e.historyResult(), Changed: changed}
}

// Metadata-only transactions share all audio and leave playback, peak request
// identities and clipboard untouched. Every fallible step precedes publication.
func (e *Engine) commitTimeline(method, label string, timeline audiobuf.Timeline, editor editorState) (protocol.TimelineMutationResult, error) {
	metadata := e.document.Metadata()
	metadata.Timeline = timeline
	document, err := e.document.WithMetadata(metadata)
	if err != nil {
		return protocol.TimelineMutationResult{}, fmt.Errorf("%s: metadata: %w", method, err)
	}
	staged := e.history
	if staged == nil {
		staged, err = newDocumentHistory(e.document, e.editor)
		if err != nil {
			return protocol.TimelineMutationResult{}, fmt.Errorf("%s: initialize history: %w", method, err)
		}
	}
	staged, err = staged.StagePush(label, historySnapshot{document: e.document, editor: editor}, historySnapshot{document: document, editor: editor})
	if err != nil {
		return protocol.TimelineMutationResult{}, fmt.Errorf("%s: retain undo history: %w", method, err)
	}
	e.document, e.editor, e.history = document, editor, staged
	return e.timelineMutationResult(true), nil
}

func nextAnchor(timeline audiobuf.Timeline) (int64, error) {
	if len(timeline.Markers)+len(timeline.Regions) >= audiobuf.MaxAnchors {
		return 0, fmt.Errorf("document already contains %d anchors", audiobuf.MaxAnchors)
	}
	if timeline.NextID > audiobuf.MaxAnchorID {
		return 0, fmt.Errorf("anchor identity exhausted")
	}
	return timeline.NextID, nil
}

func (e *Engine) addMarker(p protocol.MarkerAddParams) (protocol.TimelineMutationResult, error) {
	const method = protocol.MethodMarkersAdd
	editor, err := e.timelineControls(method, p.DocumentID, p.Selection)
	if err != nil {
		return protocol.TimelineMutationResult{}, err
	}
	if err := e.validateEditorRange(method, p.Frame, p.Frame); err != nil {
		return protocol.TimelineMutationResult{}, err
	}
	timeline := e.document.Metadata().Timeline
	id, err := nextAnchor(timeline)
	if err != nil {
		return protocol.TimelineMutationResult{}, fmt.Errorf("%s: %w", method, err)
	}
	name, color, err := anchorFields("Marker", id, p.Name, p.Color, true)
	if err != nil {
		return protocol.TimelineMutationResult{}, fmt.Errorf("%s: %w", method, err)
	}
	timeline.Markers = append(timeline.Markers, audiobuf.Marker{ID: id, Frame: p.Frame, Name: name, Color: color})
	timeline.NextID++
	return e.commitTimeline(method, "Add marker", timeline, editor)
}

func (e *Engine) addRegion(p protocol.RegionAddParams) (protocol.TimelineMutationResult, error) {
	const method = protocol.MethodRegionsAdd
	editor, err := e.timelineControls(method, p.DocumentID, p.Selection)
	if err != nil {
		return protocol.TimelineMutationResult{}, err
	}
	if err := e.validateEditorRange(method, p.Start, p.End); err != nil {
		return protocol.TimelineMutationResult{}, err
	}
	if p.Start == p.End {
		return protocol.TimelineMutationResult{}, fmt.Errorf("%s: region must be nonempty", method)
	}
	timeline := e.document.Metadata().Timeline
	id, err := nextAnchor(timeline)
	if err != nil {
		return protocol.TimelineMutationResult{}, fmt.Errorf("%s: %w", method, err)
	}
	name, color, err := anchorFields("Region", id, p.Name, p.Color, true)
	if err != nil {
		return protocol.TimelineMutationResult{}, fmt.Errorf("%s: %w", method, err)
	}
	timeline.Regions = append(timeline.Regions, audiobuf.Region{ID: id, Start: p.Start, End: p.End, Name: name, Color: color})
	timeline.NextID++
	return e.commitTimeline(method, "Add region", timeline, editor)
}

func (e *Engine) updateMarker(p protocol.MarkerUpdateParams) (protocol.TimelineMutationResult, error) {
	const method = protocol.MethodMarkersUpdate
	editor, err := e.timelineControls(method, p.DocumentID, p.Selection)
	if err != nil {
		return protocol.TimelineMutationResult{}, err
	}
	if err := e.validateEditorRange(method, p.Frame, p.Frame); err != nil {
		return protocol.TimelineMutationResult{}, err
	}
	name, color, err := anchorFields("Marker", p.ID, p.Name, p.Color, false)
	if err != nil {
		return protocol.TimelineMutationResult{}, fmt.Errorf("%s: %w", method, err)
	}
	timeline := e.document.Metadata().Timeline
	for i, marker := range timeline.Markers {
		if marker.ID != p.ID {
			continue
		}
		updated := audiobuf.Marker{ID: p.ID, Frame: p.Frame, Name: name, Color: color}
		if marker == updated {
			return e.timelineMutationResult(false), nil
		}
		timeline.Markers[i] = updated
		return e.commitTimeline(method, "Update marker", timeline, editor)
	}
	return protocol.TimelineMutationResult{}, fmt.Errorf("%s: unknown marker identity %d", method, p.ID)
}

func (e *Engine) updateRegion(p protocol.RegionUpdateParams) (protocol.TimelineMutationResult, error) {
	const method = protocol.MethodRegionsUpdate
	editor, err := e.timelineControls(method, p.DocumentID, p.Selection)
	if err != nil {
		return protocol.TimelineMutationResult{}, err
	}
	if err := e.validateEditorRange(method, p.Start, p.End); err != nil {
		return protocol.TimelineMutationResult{}, err
	}
	if p.Start == p.End {
		return protocol.TimelineMutationResult{}, fmt.Errorf("%s: region must be nonempty", method)
	}
	name, color, err := anchorFields("Region", p.ID, p.Name, p.Color, false)
	if err != nil {
		return protocol.TimelineMutationResult{}, fmt.Errorf("%s: %w", method, err)
	}
	timeline := e.document.Metadata().Timeline
	for i, region := range timeline.Regions {
		if region.ID != p.ID {
			continue
		}
		updated := audiobuf.Region{ID: p.ID, Start: p.Start, End: p.End, Name: name, Color: color}
		if region == updated {
			return e.timelineMutationResult(false), nil
		}
		timeline.Regions[i] = updated
		return e.commitTimeline(method, "Update region", timeline, editor)
	}
	return protocol.TimelineMutationResult{}, fmt.Errorf("%s: unknown region identity %d", method, p.ID)
}

func (e *Engine) removeAnchor(method string, p protocol.TimelineRemoveParams) (protocol.TimelineMutationResult, error) {
	editor, err := e.timelineControls(method, p.DocumentID, p.Selection)
	if err != nil {
		return protocol.TimelineMutationResult{}, err
	}
	timeline := e.document.Metadata().Timeline
	if method == protocol.MethodMarkersRemove {
		for i, marker := range timeline.Markers {
			if marker.ID == p.ID {
				timeline.Markers = slices.Delete(timeline.Markers, i, i+1)
				return e.commitTimeline(method, "Remove marker", timeline, editor)
			}
		}
	} else {
		for i, region := range timeline.Regions {
			if region.ID == p.ID {
				timeline.Regions = slices.Delete(timeline.Regions, i, i+1)
				return e.commitTimeline(method, "Remove region", timeline, editor)
			}
		}
	}
	return protocol.TimelineMutationResult{}, fmt.Errorf("%s: unknown anchor identity %d", method, p.ID)
}
