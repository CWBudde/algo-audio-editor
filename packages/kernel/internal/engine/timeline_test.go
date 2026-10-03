package engine

import (
	"encoding/csv"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func setTimelineFixture(t testing.TB, e *Engine, markers []protocol.TimelineMarker, regions []protocol.TimelineRegion) {
	t.Helper()
	metadata := e.document.Metadata()
	metadata.Timeline = audiobuf.Timeline{NextID: 1}
	for _, marker := range markers {
		if marker.Name == "" {
			marker.Name = fmt.Sprintf("Marker %d", marker.ID)
		}
		if marker.Color == "" {
			marker.Color = audiobuf.DefaultAnchorColor
		}
		metadata.Timeline.Markers = append(metadata.Timeline.Markers, audiobuf.Marker{ID: marker.ID, Frame: marker.Frame, Name: marker.Name, Color: marker.Color})
		metadata.Timeline.NextID = max(metadata.Timeline.NextID, marker.ID+1)
	}
	for _, region := range regions {
		if region.Name == "" {
			region.Name = fmt.Sprintf("Region %d", region.ID)
		}
		if region.Color == "" {
			region.Color = audiobuf.DefaultAnchorColor
		}
		metadata.Timeline.Regions = append(metadata.Timeline.Regions, audiobuf.Region{ID: region.ID, Start: region.Start, End: region.End, Name: region.Name, Color: region.Color})
		metadata.Timeline.NextID = max(metadata.Timeline.NextID, region.ID+1)
	}
	document, err := e.document.WithMetadata(metadata)
	if err != nil {
		t.Fatal(err)
	}
	e.document = document
	if e.history != nil {
		if err := e.history.ReplaceCurrent(historySnapshot{document: document, editor: e.editor}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestTimelineMutationsKeepPlaybackAndAudioIdentity(t *testing.T) {
	e, id := openEditorFixture(t, []float32{1, 10, 2, 20, 3, 30}, 2)
	playRange(t, e, 0, 3, true)
	if _, err := e.applyEdit(editParams(e, "copy", 0, 1, 3)); err != nil {
		t.Fatal(err)
	}
	transport, sequence, memory, clipboard := e.transport, e.documentSequence, e.documentMemory(), e.clipboardInfo()
	initial := e.historyResult().CurrentStateID
	selection := protocol.SelectionRange{Start: 1, End: 2, ChannelMask: 2}
	marker, err := e.addMarker(protocol.MarkerAddParams{DocumentID: id, Frame: 1, Color: "#ABCDEF", Selection: &selection})
	if err != nil || !marker.Changed || !marker.History.Dirty || marker.DocumentID != id || marker.Markers[0].Color != "#abcdef" || marker.History.CurrentStateID == initial {
		t.Fatalf("add marker %+v, %v", marker, err)
	}
	retained := e.documentMemory()
	if e.editor.selection != selection || e.transport != transport || !transport.playing || e.source != sourceDocument || e.documentSequence != sequence || retained.SampleBytes != memory.SampleBytes || retained.PeakBytes != memory.PeakBytes || retained.UniqueBlocks != memory.UniqueBlocks || e.clipboardInfo() != clipboard {
		t.Fatal("metadata mutation changed audio/transport/identity/clip or lost selection")
	}
	state := marker.History.CurrentStateID
	otherSelection := protocol.SelectionRange{ChannelMask: 1}
	unchanged, err := e.updateMarker(protocol.MarkerUpdateParams{ID: 1, MarkerAddParams: protocol.MarkerAddParams{DocumentID: id, Frame: 1, Name: "Marker 1", Color: "#abcdef", Selection: &otherSelection}})
	if err != nil || unchanged.Changed || unchanged.History.CurrentStateID != state || e.editor.selection != selection {
		t.Fatal("no-op update changed history/selection", err)
	}
	if _, err := e.updateMarker(protocol.MarkerUpdateParams{ID: 1, MarkerAddParams: protocol.MarkerAddParams{DocumentID: id, Frame: 3, Name: "End", Color: "#123456"}}); err != nil {
		t.Fatal(err)
	}
	region, err := e.addRegion(protocol.RegionAddParams{DocumentID: id, Start: 0, End: 2, Name: "A"})
	if err != nil || region.Regions[0].ID != 2 {
		t.Fatal("shared identity sequence", err)
	}
	if _, err := e.updateRegion(protocol.RegionUpdateParams{ID: 2, RegionAddParams: protocol.RegionAddParams{DocumentID: id, Start: 1, End: 3, Name: "B", Color: "#654321"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.removeAnchor(protocol.MethodMarkersRemove, protocol.TimelineRemoveParams{DocumentID: id, ID: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.removeAnchor(protocol.MethodRegionsRemove, protocol.TimelineRemoveParams{DocumentID: id, ID: 2}); err != nil {
		t.Fatal(err)
	}
	if len(e.timelineResult().Markers)+len(e.timelineResult().Regions) != 0 || e.document.Metadata().Timeline.NextID != 3 || e.transport != transport || !transport.playing {
		t.Fatal("remove lost allocator or stopped playback")
	}
	for range 6 {
		historyNavigate(t, e, protocol.MethodEditUndo, "")
	}
	if e.historyResult().Dirty || len(e.timelineResult().Markers)+len(e.timelineResult().Regions) != 0 {
		t.Fatal("metadata undo did not return clean original")
	}
	for range 6 {
		historyNavigate(t, e, protocol.MethodEditRedo, "")
	}
	if !e.historyResult().Dirty || e.document.Metadata().Timeline.NextID != 3 {
		t.Fatal("metadata redo did not restore exact allocator")
	}
}

func TestTimelineMutationErrorsAtomic(t *testing.T) {
	e, id := openEditorFixture(t, []float32{1, 2, 3}, 1)
	if _, err := e.configure(protocol.EngineConfigureParams{SampleRate: 48000, Channels: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.addMarker(protocol.MarkerAddParams{DocumentID: id, Frame: 1}); err != nil {
		t.Fatal(err)
	}
	playRange(t, e, 0, 3, true)
	for _, tt := range []struct {
		method string
		params any
	}{
		{protocol.MethodMarkersAdd, protocol.MarkerAddParams{DocumentID: "stale"}},
		{protocol.MethodMarkersAdd, protocol.MarkerAddParams{DocumentID: id, Color: "red"}},
		{protocol.MethodMarkersAdd, protocol.MarkerAddParams{DocumentID: id, Name: "N\x00UL"}},
		{protocol.MethodMarkersAdd, protocol.MarkerAddParams{DocumentID: id, Selection: &protocol.SelectionRange{End: 4, ChannelMask: 1}}},
		{protocol.MethodMarkersAdd, protocol.MarkerAddParams{DocumentID: id, Selection: &protocol.SelectionRange{ChannelMask: 2}}},
		{protocol.MethodMarkersUpdate, protocol.MarkerUpdateParams{ID: 1, MarkerAddParams: protocol.MarkerAddParams{DocumentID: id, Frame: -1, Name: "A"}}},
		{protocol.MethodMarkersUpdate, protocol.MarkerUpdateParams{ID: 99, MarkerAddParams: protocol.MarkerAddParams{DocumentID: id, Name: "A"}}},
		{protocol.MethodRegionsUpdate, protocol.RegionUpdateParams{ID: 1, RegionAddParams: protocol.RegionAddParams{DocumentID: id, End: 1, Name: "A"}}},
		{protocol.MethodRegionsUpdate, protocol.RegionUpdateParams{ID: 1, RegionAddParams: protocol.RegionAddParams{DocumentID: id, Name: "A"}}},
		{protocol.MethodMarkersRemove, protocol.TimelineRemoveParams{DocumentID: id, ID: 0}},
		{protocol.MethodRegionsRemove, protocol.TimelineRemoveParams{DocumentID: id, ID: 1}},
	} {
		before, transport := e.editResult(false), e.transport
		if response := editorCall(t, e, tt.method, tt.params); response.OK {
			t.Fatalf("invalid %s accepted", tt.method)
		}
		if !reflect.DeepEqual(before, e.editResult(false)) || e.transport != transport || !transport.playing {
			t.Fatalf("%s error changed state", tt.method)
		}
	}
	metadata := e.document.Metadata()
	metadata.Timeline.NextID = audiobuf.MaxAnchorID + 1
	var err error
	e.document, err = e.document.WithMetadata(metadata)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.addMarker(protocol.MarkerAddParams{DocumentID: id}); err == nil {
		t.Fatal("exhausted uint32 identity accepted")
	}
}

func TestTimelineSavepointRequiresExactMetadataState(t *testing.T) {
	e, id := openEditorFixture(t, []float32{1, 2}, 1)
	base := e.historyResult().CurrentStateID
	added, err := e.addMarker(protocol.MarkerAddParams{DocumentID: id, Frame: 1, Name: "unsaved"})
	if err != nil {
		t.Fatal(err)
	}
	// Metadata transactions deliberately retain the audio/document identity,
	// so a delayed acknowledgement must still reject the obsolete state ID.
	if _, err := e.markSaved(protocol.MarkSavedParams{DocumentID: id, StateID: base}); err == nil {
		t.Fatal("stale metadata save acknowledgement marked the current state clean")
	}
	if !e.historyResult().Dirty {
		t.Fatal("failed acknowledgement cleared annotation dirty state")
	}
	if result, err := e.markSaved(protocol.MarkSavedParams{DocumentID: id, StateID: added.History.CurrentStateID}); err != nil || result.Dirty {
		t.Fatalf("exact annotation save acknowledgement failed: %+v, %v", result, err)
	}
	undone := historyNavigate(t, e, protocol.MethodEditUndo, "")
	if !undone.History.Dirty {
		t.Fatal("undo away from saved annotations was clean")
	}
	redone := historyNavigate(t, e, protocol.MethodEditRedo, "")
	if redone.History.Dirty {
		t.Fatal("redo to saved annotations was dirty")
	}
}

func TestTimelineCSVAndLabelsReadOnly(t *testing.T) {
	e, id := openEditorFixture(t, make([]float32, 48000), 1)
	setTimelineFixture(t, e, []protocol.TimelineMarker{{ID: 1, Frame: 24000, Name: "half, \"quoted\""}}, []protocol.TimelineRegion{{ID: 2, Start: 0, End: 48000, Name: "whole"}})
	before := e.editResult(false)
	info, err := e.exportTimeline(protocol.TimelineExportParams{DocumentID: id, Format: "csv"})
	if err != nil || info.Name != "editor.markers.csv" || info.MimeType != "text/csv" {
		t.Fatalf("CSV export %+v, %v", info, err)
	}
	data := e.TakeData()
	rows, err := csv.NewReader(strings.NewReader(string(data))).ReadAll()
	if err != nil || len(rows) != 3 || rows[1][0] != "region" || rows[1][6] != "0.000000000" || rows[1][7] != "1.000000000" || rows[2][2] != "half, \"quoted\"" || rows[2][6] != "0.500000000" || len(data) != info.DataBytes {
		t.Fatalf("CSV records %v, %v", rows, err)
	}
	info, err = e.exportTimeline(protocol.TimelineExportParams{DocumentID: id, Format: "labels"})
	if err != nil || info.Name != "editor.labels.txt" || string(e.TakeData()) != "0.000000000\t1.000000000\twhole\n0.500000000\t0.500000000\thalf, \"quoted\"\n" {
		t.Fatalf("label export %+v, %v", info, err)
	}
	if !reflect.DeepEqual(before, e.editResult(false)) {
		t.Fatal("read-only export changed history/document")
	}
	for _, name := range []string{"has\ttab", "has\rCR", "has\nLF"} {
		setTimelineFixture(t, e, []protocol.TimelineMarker{{ID: 1, Name: name}}, nil)
		if response := editorCall(t, e, protocol.MethodTimelineExport, protocol.TimelineExportParams{DocumentID: id, Format: "labels"}); response.OK || len(e.TakeData()) != 0 {
			t.Fatal("ambiguous label name exported")
		}
		if response := editorCall(t, e, protocol.MethodTimelineExport, protocol.TimelineExportParams{DocumentID: id, Format: "csv"}); !response.OK {
			t.Fatal("CSV unnecessarily rejected name", response.Error)
		}
	}
	for _, p := range []protocol.TimelineExportParams{{DocumentID: id, Format: "bad"}, {DocumentID: "stale", Format: "csv"}} {
		if response := editorCall(t, e, protocol.MethodTimelineExport, p); response.OK || len(e.TakeData()) != 0 {
			t.Fatal("invalid export accepted or leaked bulk bytes")
		}
	}
	if got := timelineSeconds(1<<53-1, 384000); got != "23456248059.221330729" {
		t.Fatalf("exact long seconds = %s", got)
	}
}
