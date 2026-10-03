package engine

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func openEditorFixture(t *testing.T, samples []float32, channels int) (*Engine, string) {
	t.Helper()
	pcm := make([]byte, len(samples)*4)
	for i, sample := range samples {
		binary.LittleEndian.PutUint32(pcm[i*4:], math.Float32bits(sample))
	}
	e := New()
	info, err := e.openDocument(protocol.DocumentOpenParams{Name: "editor.wav"}, rawWAV(3, 32, channels, 48000, pcm, false))
	if err != nil {
		t.Fatal(err)
	}
	return e, info.DocumentID
}

func editorCall(t *testing.T, e *Engine, method string, params any) protocol.Response {
	t.Helper()
	payload, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	var response protocol.Response
	if err := json.Unmarshal(e.Call(method, payload), &response); err != nil {
		t.Fatal(err)
	}
	return response
}

func TestEditorDocumentIdentityAndReset(t *testing.T) {
	e, id := openEditorFixture(t, []float32{0, 1, -1, 0}, 2)
	if id == "" || e.selectionResult() != (protocol.SelectionResult{DocumentID: id, SelectionRange: protocol.SelectionRange{ChannelMask: 3}}) {
		t.Fatalf("invalid default selection %+v", e.selectionResult())
	}
	selected := protocol.SelectionSetParams{DocumentID: id, SelectionRange: protocol.SelectionRange{Start: 1, End: 2, ChannelMask: 2}}
	if response := editorCall(t, e, protocol.MethodSelectionSet, selected); !response.OK {
		t.Fatal(response.Error)
	}
	if _, err := e.addMarker(protocol.MarkerAddParams{DocumentID: id, Frame: 2}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.addRegion(protocol.RegionAddParams{DocumentID: id, End: 2}); err != nil {
		t.Fatal(err)
	}
	beforeSelection, beforeTimeline := e.selectionResult(), e.timelineResult()
	if _, err := e.openDocument(protocol.DocumentOpenParams{Name: "bad.wav"}, []byte("bad")); err == nil {
		t.Fatal("malformed open succeeded")
	}
	if e.selectionResult() != beforeSelection || !reflect.DeepEqual(e.timelineResult(), beforeTimeline) || e.documentSequence != 1 {
		t.Fatal("failed open changed editor state or identity sequence")
	}
	// Reopening the same name and exact bytes still creates a fresh identity.
	pcm := make([]byte, 16)
	for i, sample := range []float32{0, 1, -1, 0} {
		binary.LittleEndian.PutUint32(pcm[i*4:], math.Float32bits(sample))
	}
	info, err := e.openDocument(protocol.DocumentOpenParams{Name: "editor.wav"}, rawWAV(3, 32, 2, 48000, pcm, false))
	if err != nil || info.DocumentID == id || e.documentSequence != 2 {
		t.Fatalf("reopen identity %+v, %v", info, err)
	}
	if e.selectionResult().SelectionRange != (protocol.SelectionRange{ChannelMask: 3}) || len(e.timelineResult().Markers)+len(e.timelineResult().Regions) != 0 {
		t.Fatal("successful open did not reset document editor state")
	}
	for _, method := range []string{protocol.MethodSelectionGet, protocol.MethodSelectionSet, protocol.MethodSelectionSnap, protocol.MethodTimelineGet, protocol.MethodMarkersAdd, protocol.MethodRegionsAdd} {
		if response := editorCall(t, e, method, map[string]any{"documentId": id}); response.OK {
			t.Fatalf("%s accepted stale document identity", method)
		}
	}
	e.documentSequence = math.MaxUint64
	current := e.selectionResult()
	if _, err := e.openDocument(protocol.DocumentOpenParams{}, minimalPCM16WAV()); err == nil || current != e.selectionResult() {
		t.Fatal("exhausted identity sequence was not rejected atomically")
	}
}

func TestSelectionValidationAtomic(t *testing.T) {
	e, id := openEditorFixture(t, make([]float32, 16), 2)
	before := e.selectionResult()
	for _, fields := range []string{
		`"start":-1,"end":0,"channelMask":1`,
		`"start":2,"end":1,"channelMask":1`,
		`"start":0,"end":9,"channelMask":1`,
		`"start":0,"end":9007199254740992,"channelMask":1`,
		`"start":0.5,"end":2,"channelMask":1`,
		`"start":0,"end":2,"channelMask":0`,
		`"start":0,"end":2,"channelMask":-1`,
		`"start":0,"end":2,"channelMask":4`,
		`"start":0,"end":2,"channelMask":1.5`,
	} {
		response := call(t, e, protocol.MethodSelectionSet, fmt.Sprintf(`{"documentId":%q,%s}`, id, fields))
		if response.OK || e.selectionResult() != before {
			t.Fatalf("invalid selection %s: response %+v, state %+v", fields, response, e.selectionResult())
		}
	}
	for _, selection := range []protocol.SelectionRange{{Start: 8, End: 8, ChannelMask: 1}, {End: 8, ChannelMask: 3}, {Start: 3, End: 5, ChannelMask: 2}} {
		response := editorCall(t, e, protocol.MethodSelectionSet, protocol.SelectionSetParams{DocumentID: id, SelectionRange: selection})
		if !response.OK {
			t.Fatal(response.Error)
		}
		var got protocol.SelectionResult
		if err := json.Unmarshal(response.Result, &got); err != nil || got.SelectionRange != selection || got.DocumentID != id {
			t.Fatalf("selection result %+v, error %v", got, err)
		}
		if response := editorCall(t, e, protocol.MethodSelectionGet, protocol.SelectionGetParams{DocumentID: id}); !response.OK {
			t.Fatal(response.Error)
		}
	}
	for _, method := range []string{protocol.MethodSelectionGet, protocol.MethodSelectionSet, protocol.MethodSelectionSnap, protocol.MethodTimelineGet, protocol.MethodMarkersAdd, protocol.MethodRegionsAdd} {
		for _, payload := range []string{"", "null", "{", `{"documentId":"missing"}`} {
			if response := call(t, e, method, payload); response.OK {
				t.Fatalf("%s accepted invalid payload %q", method, payload)
			}
		}
		if response := editorCall(t, New(), method, map[string]any{"documentId": id}); response.OK {
			t.Fatalf("%s accepted missing document", method)
		}
	}
}

func TestTimelineAnchorsAndSnapshots(t *testing.T) {
	e, id := openEditorFixture(t, make([]float32, 8), 1)
	response := editorCall(t, e, protocol.MethodTimelineGet, protocol.TimelineGetParams{DocumentID: id})
	if !response.OK || !strings.Contains(string(response.Result), `"markers":[]`) || !strings.Contains(string(response.Result), `"regions":[]`) {
		t.Fatalf("empty timeline arrays %+v", response)
	}
	if response := editorCall(t, e, protocol.MethodMarkersAdd, protocol.MarkerAddParams{DocumentID: id, Frame: 8}); !response.OK {
		t.Fatal(response.Error)
	}
	if response := editorCall(t, e, protocol.MethodRegionsAdd, protocol.RegionAddParams{DocumentID: id, Start: 2, End: 8, Name: " \t chorus \n"}); !response.OK {
		t.Fatal(response.Error)
	}
	if _, err := e.addRegion(protocol.RegionAddParams{DocumentID: id, End: 1}); err != nil {
		t.Fatal(err)
	}
	got := e.timelineResult()
	if got.Markers[0] != (protocol.TimelineMarker{ID: 1, Frame: 8, Name: "Marker 1", Color: audiobuf.DefaultAnchorColor}) || got.Regions[0] != (protocol.TimelineRegion{ID: 2, Start: 2, End: 8, Name: "chorus", Color: audiobuf.DefaultAnchorColor}) || got.Regions[1].Name != "Region 3" {
		t.Fatalf("unexpected anchors %+v", got)
	}
	got.Markers[0].Name, got.Regions[0].Start = "changed", 7
	if e.timelineResult().Markers[0].Name != "Marker 1" || e.timelineResult().Regions[0].Start != 2 {
		t.Fatal("returned timeline aliases stored state")
	}
	before := e.timelineResult()
	for _, tt := range []struct {
		method string
		params any
	}{
		{protocol.MethodMarkersAdd, protocol.MarkerAddParams{DocumentID: id, Frame: -1}},
		{protocol.MethodMarkersAdd, protocol.MarkerAddParams{DocumentID: id, Frame: 9}},
		{protocol.MethodMarkersAdd, protocol.MarkerAddParams{DocumentID: id, Name: strings.Repeat("a", 257)}},
		{protocol.MethodRegionsAdd, protocol.RegionAddParams{DocumentID: id}},
		{protocol.MethodRegionsAdd, protocol.RegionAddParams{DocumentID: id, Start: 3, End: 2}},
		{protocol.MethodRegionsAdd, protocol.RegionAddParams{DocumentID: id, Start: -1, End: 2}},
		{protocol.MethodRegionsAdd, protocol.RegionAddParams{DocumentID: id, End: 9}},
		{protocol.MethodRegionsAdd, protocol.RegionAddParams{DocumentID: id, End: 1, Name: strings.Repeat("é", 129)}},
	} {
		if response := editorCall(t, e, tt.method, tt.params); response.OK || !reflect.DeepEqual(before, e.timelineResult()) {
			t.Fatalf("invalid %s changed timeline: %+v", tt.method, response)
		}
	}
	if _, err := e.addMarker(protocol.MarkerAddParams{DocumentID: id, Name: string([]byte{0xff})}); err == nil {
		t.Fatal("invalid UTF-8 name accepted")
	}
	if _, err := e.addMarker(protocol.MarkerAddParams{DocumentID: id, Name: strings.Repeat("é", 128)}); err != nil {
		t.Fatal("valid 256-byte name rejected", err)
	}
	markers := make([]protocol.TimelineMarker, maxAnchors-len(e.timelineResult().Regions)-1)
	for i := range markers {
		markers[i].ID = int64(i + 1)
		if i > 0 {
			markers[i].ID += int64(len(e.timelineResult().Regions))
		}
	}
	setTimelineFixture(t, e, markers, e.timelineResult().Regions)
	last, err := e.addMarker(protocol.MarkerAddParams{DocumentID: id})
	if err != nil || last.Markers[len(last.Markers)-1].ID != maxAnchors {
		t.Fatalf("last allowed anchor error %v", err)
	}
	for _, method := range []string{protocol.MethodMarkersAdd, protocol.MethodRegionsAdd} {
		if response := editorCall(t, e, method, map[string]any{"documentId": id, "end": 1}); response.OK || len(e.timelineResult().Markers)+len(e.timelineResult().Regions) != maxAnchors {
			t.Fatalf("anchor cap not atomic for %s", method)
		}
	}
}

func TestSelectionSnap(t *testing.T) {
	for _, tt := range []struct {
		name     string
		samples  []float32
		channels int
		frame    int64
		radius   int64
		mask     int
		want     int64
		found    bool
	}{
		{"exact zero", []float32{1, 0, -1}, 1, 1, 0, 1, 1, true},
		{"lookback crossing", []float32{1, 1, -1, -1}, 1, 2, 0, 1, 2, true},
		{"left radius boundary", []float32{1, 1, -1, -1, -1}, 1, 3, 1, 1, 2, true},
		{"right radius boundary", []float32{1, 1, 1, -1}, 1, 1, 2, 1, 3, true},
		{"earlier tie", []float32{1, 0, 1, 0, 1}, 1, 2, 1, 1, 1, true},
		{"EOF", []float32{1, 1, 0}, 1, 3, 1, 1, 2, true},
		{"EOF no synthetic zero", []float32{1, 0}, 1, 2, 0, 1, 2, false},
		{"signed zero", []float32{1, math.Float32frombits(0x80000000)}, 1, 1, 0, 1, 1, true},
		{"no crossing", []float32{1, 1, 1}, 1, 1, 2, 1, 1, false},
		{"exclude left outside radius", []float32{1, 0, 1, 1, 1}, 1, 3, 1, 1, 3, false},
		{"exclude right outside radius", []float32{1, 1, 1, 1, 0}, 1, 2, 1, 1, 2, false},
		{"nonfinite not bridged", []float32{1, float32(math.NaN()), -1, float32(math.Inf(1)), -1}, 1, 2, 2, 1, 2, false},
		{"channel one", []float32{1, 1, 1, -1, -1, -1}, 2, 1, 1, 1, 2, true},
		{"channel two", []float32{1, 1, 1, -1, -1, -1}, 2, 1, 1, 2, 1, true},
		{"selected channels tie", []float32{1, 1, 1, -1, 1, -1, -1, -1}, 2, 2, 1, 3, 1, true},
		{"empty eight channels", nil, 8, 0, maxSnapRadius, 255, 0, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			e, id := openEditorFixture(t, tt.samples, tt.channels)
			before := e.selectionResult()
			response := editorCall(t, e, protocol.MethodSelectionSnap, protocol.SelectionSnapParams{DocumentID: id, Frame: tt.frame, Radius: tt.radius, ChannelMask: tt.mask})
			var got protocol.SelectionSnapResult
			if !response.OK || json.Unmarshal(response.Result, &got) != nil || got.Frame != tt.want || got.Found != tt.found || got.DocumentID != id {
				t.Fatalf("snap %+v, response %+v", got, response)
			}
			if e.selectionResult() != before {
				t.Fatal("snap mutated selection")
			}
		})
	}
	e, id := openEditorFixture(t, []float32{1, -1}, 1)
	for _, params := range []protocol.SelectionSnapParams{
		{DocumentID: id, Frame: -1, ChannelMask: 1},
		{DocumentID: id, Frame: 3, ChannelMask: 1},
		{DocumentID: id, Radius: -1, ChannelMask: 1},
		{DocumentID: id, Radius: maxSnapRadius + 1, ChannelMask: 1},
		{DocumentID: id, Radius: math.MaxInt64, ChannelMask: 1},
		{DocumentID: id, ChannelMask: 2},
	} {
		if response := editorCall(t, e, protocol.MethodSelectionSnap, params); response.OK {
			t.Fatalf("invalid snap accepted %+v", params)
		}
	}
}

func TestEditorFramesBeyondInt32AndBoundedSnap(t *testing.T) {
	e, id := openEditorFixture(t, nil, 1)
	samples := make([]float32, audiobuf.BlockFrames)
	for i := range samples {
		samples[i] = 1
	}
	samples[7] = -1
	samples[len(samples)-1] = -1
	block, err := audiobuf.NewBlock(samples)
	if err != nil {
		t.Fatal(err)
	}
	blocks := make([]*audiobuf.Block, 32769)
	for i := range blocks {
		blocks[i] = block
	}
	channel, err := audiobuf.NewChannelFromBlocks(blocks)
	if err != nil {
		t.Fatal(err)
	}
	e.document, err = audiobuf.NewDocument([]audiobuf.Channel{channel}, 48000, audiobuf.Metadata{})
	if err != nil {
		t.Fatal(err)
	}
	frame := int64(1<<31) + 7
	selection := protocol.SelectionSetParams{DocumentID: id, SelectionRange: protocol.SelectionRange{Start: frame, End: frame + 100, ChannelMask: 1}}
	if _, err := e.setSelection(selection); err != nil {
		t.Fatal(err)
	}
	if _, err := e.addMarker(protocol.MarkerAddParams{DocumentID: id, Frame: frame}); err != nil {
		t.Fatal(err)
	}
	got, err := e.snapSelection(protocol.SelectionSnapParams{DocumentID: id, Frame: frame - 1, Radius: maxSnapRadius, ChannelMask: 1})
	if err != nil || !got.Found || got.Frame != frame {
		t.Fatalf("long-frame snap %+v, %v", got, err)
	}
	if e.selectionResult().Start != frame || e.timelineResult().Markers[0].Frame != frame {
		t.Fatal("long-frame coordinates narrowed")
	}
	boundary, err := e.snapSelection(protocol.SelectionSnapParams{DocumentID: id, Frame: 1 << 31, ChannelMask: 1})
	if err != nil || !boundary.Found || boundary.Frame != 1<<31 {
		t.Fatalf("block-boundary lookback %+v, %v", boundary, err)
	}
	if _, err := e.addRegion(protocol.RegionAddParams{DocumentID: id, Start: frame, End: frame + 50}); err != nil || e.timelineResult().Regions[0].End != frame+50 {
		t.Fatalf("long-frame region %v", err)
	}
	// A query's allocations depend only on radius, not document duration.
	if allocations := testing.AllocsPerRun(20, func() {
		if _, err := e.snapSelection(protocol.SelectionSnapParams{DocumentID: id, Frame: frame, Radius: maxSnapRadius, ChannelMask: 1}); err != nil {
			panic(err)
		}
	}); allocations != 1 {
		t.Fatalf("bounded snap allocated %v objects, want one reusable channel window", allocations)
	}
}

func TestEmptyDocumentEditor(t *testing.T) {
	e, id := openEditorFixture(t, nil, 8)
	if got := e.selectionResult(); got.Start != 0 || got.End != 0 || got.ChannelMask != 255 {
		t.Fatalf("empty document defaults %+v", got)
	}
	if _, err := e.addMarker(protocol.MarkerAddParams{DocumentID: id}); err != nil {
		t.Fatal("empty EOF marker rejected", err)
	}
	if _, err := e.addRegion(protocol.RegionAddParams{DocumentID: id}); err == nil {
		t.Fatal("empty region accepted")
	}
	if _, err := e.dispatchEditor("unknown.editor", nil); err == nil {
		t.Fatal("unknown editor dispatch accepted")
	}
}
