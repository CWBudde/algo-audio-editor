package engine

import (
	"bytes"
	"encoding/binary"
	"math"
	"reflect"
	"slices"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
	"github.com/cwbudde/wav"
)

func timelineRIFFChunk(id string, payload []byte) []byte {
	chunk := make([]byte, 8+len(payload)+len(payload)%2)
	copy(chunk, id)
	binary.LittleEndian.PutUint32(chunk[4:8], uint32(len(payload)))
	copy(chunk[8:], payload)
	return chunk
}

func wavWithTimeline(base []byte, before bool, chunks ...[]byte) []byte {
	result := slices.Clone(base[:12])
	if !before {
		result = append(result, base[12:]...)
	}
	for _, chunk := range chunks {
		result = append(result, chunk...)
	}
	if before {
		result = append(result, base[12:]...)
	}
	binary.LittleEndian.PutUint32(result[4:8], uint32(len(result)-8))
	return result
}

// Independent wire goldens keep the application mapping honest without using
// the serializer under test to construct the incoming cue/adtl fixtures.
func timelineCue(id, frame uint32) []byte {
	payload := make([]byte, 28)
	binary.LittleEndian.PutUint32(payload, 1)
	binary.LittleEndian.PutUint32(payload[4:], id)
	copy(payload[12:], "data")
	binary.LittleEndian.PutUint32(payload[24:], frame)
	return timelineRIFFChunk("cue ", payload)
}

func timelineTwoCues(first, second uint32) []byte {
	payload := slices.Clone(timelineCue(first, 1)[8:])
	binary.LittleEndian.PutUint32(payload, 2)
	payload = append(payload, timelineCue(second, 2)[12:]...)
	return timelineRIFFChunk("cue ", payload)
}

func timelineLabel(id uint32, name string) []byte {
	payload := make([]byte, 4+len(name)+1)
	binary.LittleEndian.PutUint32(payload, id)
	copy(payload[4:], name)
	return timelineRIFFChunk("labl", payload)
}

func timelineRegion(id, length uint32, text string) []byte {
	payload := make([]byte, 20+len(text)+1)
	binary.LittleEndian.PutUint32(payload, id)
	binary.LittleEndian.PutUint32(payload[4:], length)
	copy(payload[8:], "rgn ")
	copy(payload[20:], text)
	return timelineRIFFChunk("ltxt", payload)
}

func timelineADTL(subchunks ...[]byte) []byte {
	data := []byte("adtl")
	for _, chunk := range subchunks {
		data = append(data, chunk...)
	}
	return timelineRIFFChunk("LIST", data)
}

func TestWAVTimelineRoundTripAndStandardChunks(t *testing.T) {
	original := []float32{math.Float32frombits(0x80000000), math.Float32frombits(0x7fc12345), math.Float32frombits(1), math.Float32frombits(0x7f800000), -1, 0.5}
	e, _ := openEditorFixture(t, original, 2)
	setTimelineFixture(
		t, e,
		[]protocol.TimelineMarker{{ID: 3, Frame: 3, Name: "EOF 🎵", Color: "#123456"}},
		[]protocol.TimelineRegion{{ID: 8, Start: 0, End: 2, Name: "résumé, \"one\"", Color: "#abcdef"}},
	)
	metadata := e.doc.document.Metadata()
	metadata.Timeline.NextID = 42 // Removed identities must not be reused after reopen.
	var err error
	e.doc.document, err = e.doc.document.WithMetadata(metadata)
	if err != nil {
		t.Fatal(err)
	}
	before := e.editResult(false)
	info, err := e.exportDocument(protocol.DocumentExportParams{Format: "wav", BitDepth: 32, Float: true})
	if err != nil {
		t.Fatal(err)
	}
	output := e.TakeData()
	if info.DataBytes != len(output) || int(binary.LittleEndian.Uint32(output[4:8])) != len(output)-8 {
		t.Fatal("metadata excluded from exact export/container size")
	}
	layout, err := inspectWAV(output)
	if err != nil {
		t.Fatal(err)
	}
	if len(layout.timelineChunks) != 3 {
		t.Fatalf("want color, cue and adtl chunks, got %d", len(layout.timelineChunks))
	}
	if !bytes.Contains(output, []byte("cue ")) || !bytes.Contains(output, []byte("adtl")) || !bytes.Contains(output, []byte("labl")) || !bytes.Contains(output, []byte("ltxt")) {
		t.Fatal("export omitted standard annotations")
	}
	standard := wav.NewDecoder(bytes.NewReader(output))
	standard.ReadMetadata()
	if err := standard.Err(); err != nil {
		t.Fatal(err)
	}
	if standard.Metadata == nil || len(standard.Metadata.CuePoints) != 2 || standard.Metadata.AssociatedData == nil || len(standard.Metadata.AssociatedData.Labels) != 2 || len(standard.Metadata.AssociatedData.Regions) != 1 {
		t.Fatalf("standard decoder cannot read annotation export: %+v", standard.Metadata)
	}
	if region := standard.Metadata.AssociatedData.Regions[0]; region.CuePointID != 8 || region.SampleLength != 2 {
		t.Fatalf("wrong standard region %+v", region)
	}
	if !reflect.DeepEqual(before, e.editResult(false)) {
		t.Fatal("WAV export mutated history or controls")
	}
	reopened := &Engine{}
	if _, err := reopened.openDocument(protocol.DocumentOpenParams{Name: "roundtrip.wav"}, output); err != nil {
		t.Fatal(err)
	}
	assertEditBits(t, editSamples(t, reopened), original)
	if !reflect.DeepEqual(reopened.doc.document.Metadata().Timeline, metadata.Timeline) {
		t.Fatalf("timeline changed: %+v", reopened.doc.document.Metadata().Timeline)
	}
	if reopened.historyResult().Dirty || reopened.historyResult().CanUndo {
		t.Fatal("import did not start a clean base history")
	}
	clear(output)
	if !reflect.DeepEqual(reopened.doc.document.Metadata().Timeline, metadata.Timeline) {
		t.Fatal("import retained mutable file storage")
	}
}

func TestWAVForeignTimelineOrderPaddingAndIDs(t *testing.T) {
	base := rawWAV(1, 8, 1, 48000, []byte{0, 128, 255}, false)
	for _, before := range []bool{false, true} {
		for _, id := range []uint32{0, 7, math.MaxUint32} {
			e := &Engine{}
			// Odd name payload, multiple LISTs and adtl before cue exercise both
			// nested padding and order-independent reference resolution.
			input := wavWithTimeline(base, before, timelineADTL(timelineLabel(id, "é")), timelineADTL(timelineRegion(id, 2, "fallback")), timelineCue(id, 1))
			if _, err := e.openDocument(protocol.DocumentOpenParams{}, input); err != nil {
				t.Fatalf("before=%t id=%d: %v", before, id, err)
			}
			got := e.doc.document.Metadata().Timeline
			wantID := int64(id)
			if wantID == 0 {
				wantID = 1
			}
			want := audiobuf.Timeline{NextID: wantID + 1, Regions: []audiobuf.Region{{ID: wantID, Start: 1, End: 3, Name: "é", Color: audiobuf.DefaultAnchorColor}}}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("foreign mapping %+v, want %+v", got, want)
			}
		}
	}
	// A legal foreign zero ID must find a free slot when MaxUint32 is taken.
	e := &Engine{}
	if _, err := e.openDocument(protocol.DocumentOpenParams{}, wavWithTimeline(base, false, timelineTwoCues(0, math.MaxUint32))); err != nil {
		t.Fatal(err)
	}
	if timeline := e.doc.document.Metadata().Timeline; len(timeline.Markers) != 2 || timeline.Markers[0].ID != 1 || timeline.Markers[1].ID != math.MaxUint32 || timeline.NextID != audiobuf.MaxAnchorID+1 {
		t.Fatalf("zero identity remapping collided: %+v", timeline)
	}
	// Deleted anchors still consume identities, even in an otherwise empty file.
	for _, nextID := range []int64{2, audiobuf.MaxAnchorID + 1} {
		timeline := audiobuf.Timeline{NextID: nextID}
		chunks, size, err := encodeWAVTimeline(timeline, 3)
		if err != nil || len(chunks) != 1 || size != int64(8+len(chunks[0].Data)+len(chunks[0].Data)%2) {
			t.Fatalf("empty allocator encoding: %v", err)
		}
		decoded, err := decodeWAVTimeline([]wavTimelineChunk{{id: chunks[0].ID, data: chunks[0].Data}}, 3)
		if err != nil || !reflect.DeepEqual(decoded, timeline) {
			t.Fatalf("empty allocator roundtrip %+v: %v", decoded, err)
		}
	}
}

func TestWAVTimelineInvalidImportsAreAtomic(t *testing.T) {
	base := rawWAV(1, 16, 1, 48000, intPayload(16, []int32{1, 2, 3}), false)
	for _, tt := range []struct {
		name   string
		chunks [][]byte
	}{
		{"short cue", [][]byte{timelineRIFFChunk("cue ", []byte{1, 0, 0, 0})}},
		{"cue past EOF", [][]byte{timelineCue(1, 4)}},
		{"duplicate cue", [][]byte{timelineCue(1, 1), timelineCue(2, 2)}},
		{"duplicate cue identity", [][]byte{timelineTwoCues(1, 1)}},
		{"orphan label", [][]byte{timelineADTL(timelineLabel(1, "orphan"))}},
		{"duplicate label", [][]byte{timelineCue(1, 1), timelineADTL(timelineLabel(1, "a"), timelineLabel(1, "b"))}},
		{"region past EOF", [][]byte{timelineCue(1, 2), timelineADTL(timelineRegion(1, 2, "region"))}},
		{"unterminated nested chunk", [][]byte{timelineRIFFChunk("LIST", []byte("adtllabl"))}},
		{"unknown extension version", [][]byte{timelineRIFFChunk("aeMD", []byte(`{"version":2,"nextId":1,"colors":[]}`))}},
		{"reused identity", [][]byte{timelineCue(3, 1), timelineRIFFChunk("aeMD", []byte(`{"version":1,"nextId":3,"colors":[]}`))}},
		{"orphan color", [][]byte{timelineRIFFChunk("aeMD", []byte(`{"version":1,"nextId":2,"colors":[{"id":1,"color":"#123456"}]}`))}},
		{"invalid color", [][]byte{timelineCue(1, 1), timelineRIFFChunk("aeMD", []byte(`{"version":1,"nextId":2,"colors":[{"id":1,"color":"red"}]}`))}},
		{"metadata budget", [][]byte{timelineRIFFChunk("aeMD", make([]byte, maxTimelineMetadataBytes))}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			e, _ := openEditorFixture(t, []float32{1, 2, 3}, 1)
			if _, err := e.configure(protocol.EngineConfigureParams{SampleRate: 48000, Channels: 1}); err != nil {
				t.Fatal(err)
			}
			if _, err := e.addMarker(protocol.MarkerAddParams{DocumentID: e.doc.editor.documentID, Frame: 1, Name: "keep"}); err != nil {
				t.Fatal(err)
			}
			if _, err := e.applyEdit(editParams(e, "copy", 0, 1, 1)); err != nil {
				t.Fatal(err)
			}
			playRange(t, e, 0, 3, true)
			before, transport, clipboard := e.editResult(false), e.playback.transport, e.clipboardInfo()
			if _, err := e.openDocument(protocol.DocumentOpenParams{}, wavWithTimeline(base, true, tt.chunks...)); err == nil {
				t.Fatal("invalid annotation accepted")
			}
			if !reflect.DeepEqual(before, e.editResult(false)) || e.playback.transport != transport || !transport.playing || e.clipboardInfo() != clipboard {
				t.Fatal("failed annotation import changed live document/history/transport/clipboard")
			}
		})
	}
}

func TestWAVTimelineUint32AnnotationLimits(t *testing.T) {
	for _, timeline := range []audiobuf.Timeline{
		{NextID: 2, Markers: []audiobuf.Marker{{ID: 1, Frame: math.MaxUint32 + 1, Name: "too far", Color: audiobuf.DefaultAnchorColor}}},
		{NextID: 2, Regions: []audiobuf.Region{{ID: 1, Start: 0, End: math.MaxUint32 + 1, Name: "too long", Color: audiobuf.DefaultAnchorColor}}},
	} {
		if _, _, err := encodeWAVTimeline(timeline, math.MaxUint32+1); err == nil {
			t.Fatal("unsupported uint32 annotation silently truncated")
		}
	}
}
