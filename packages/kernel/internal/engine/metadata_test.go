package engine

import (
	"bytes"
	"encoding/binary"
	"math"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
	"github.com/cwbudde/wav"
)

func metadataFixture(t *testing.T) (*Engine, []byte) {
	t.Helper()
	e, _ := openEditorFixture(t, []float32{-0.5, 0, 0.5, math.Float32frombits(0x80000000)}, 1)
	if _, err := e.exportDocument(protocol.DocumentExportParams{Format: "wav", BitDepth: 32, Float: true}); err != nil {
		t.Fatal(err)
	}
	base := slices.Clone(e.bulkData)
	info := append([]byte("INFO"), timelineRIFFChunk("INAM", []byte("Before\x00"))...)
	info = append(info, timelineRIFFChunk("IART", []byte("Artist\x00"))...)
	info = append(info, timelineRIFFChunk("ZZZZ", []byte{9, 8, 7})...)
	bext := make([]byte, 602)
	copy(bext, "Broadcast description")
	binary.LittleEndian.PutUint64(bext[338:], 123456)
	base = wavWithTimeline(base, true, timelineRIFFChunk("LIST", info), timelineRIFFChunk("bext", bext), timelineRIFFChunk("xtra", []byte{1, 2, 3}))
	if _, err := e.openWAVDocument(protocol.DocumentOpenParams{Name: "metadata.wav"}, base); err != nil {
		t.Fatal(err)
	}
	return e, base
}

func TestMetadataTransactions(t *testing.T) {
	e, _ := metadataFixture(t)
	before := e.editResult(false)
	memory := e.documentMemory()
	selection := e.doc.editor.selection
	pcm := e.doc.document
	initial, err := e.getMetadata(protocol.MetadataGetParams{DocumentID: e.doc.editor.documentID})
	if err != nil {
		t.Fatal(err)
	}
	if initial.Tags["title"] != "Before" || initial.Tags["artist"] != "Artist" || initial.PreservedBytes == 0 {
		t.Fatalf("metadata: %#v", initial)
	}
	if _, err := e.configure(protocol.EngineConfigureParams{SampleRate: 48000, Channels: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.playDocument(protocol.TransportPlayParams{Loop: true}); err != nil {
		t.Fatal(err)
	}
	transport := e.playback.transport
	initial.Tags["title"] = "caller"
	if e.doc.document.Metadata().Tags["title"] != "Before" {
		t.Fatal("metadata reply aliases document")
	}
	changed, err := e.setMetadata(protocol.MetadataSetParams{DocumentID: e.doc.editor.documentID, StateID: e.historyState.history.CurrentID(), Tags: map[string]string{"title": "Après 🎵", "artist": "Artist", "comment": "line 1\nline 2"}})
	if err != nil {
		t.Fatal(err)
	}
	if !changed.Changed || !changed.History.Dirty || len(changed.History.Entries) != len(before.History.Entries)+1 {
		t.Fatalf("transaction: %#v", changed)
	}
	if memory.SampleBytes != e.documentMemory().SampleBytes || memory.PeakBytes != e.documentMemory().PeakBytes || !reflect.DeepEqual(selection, e.doc.editor.selection) {
		t.Fatal("metadata changed audio/selection")
	}
	if e.playback.transport != transport || e.playback.source != sourceDocument || !e.playback.transport.playing {
		t.Fatal("metadata interrupted playback")
	}
	if audiobuf.CountMemory(pcm, e.doc.document).SampleBytes != memory.SampleBytes {
		t.Fatal("metadata did not share sample storage")
	}
	noOp, err := e.setMetadata(protocol.MetadataSetParams{DocumentID: e.doc.editor.documentID, StateID: e.historyState.history.CurrentID(), Tags: changed.Tags})
	if err != nil || noOp.Changed || noOp.StateID != changed.StateID {
		t.Fatalf("no-op: %#v, %v", noOp, err)
	}
	if _, err := e.navigateHistory(protocol.MethodEditUndo, e.doc.editor.documentID, ""); err != nil {
		t.Fatal(err)
	}
	if e.doc.document.Metadata().Tags["title"] != "Before" || e.historyResult().Dirty {
		t.Fatal("undo did not restore tags and save point")
	}
	if _, err := e.navigateHistory(protocol.MethodEditRedo, e.doc.editor.documentID, ""); err != nil {
		t.Fatal(err)
	}
	if e.doc.document.Metadata().Tags["title"] != "Après 🎵" {
		t.Fatal("redo did not restore tags")
	}
	for _, tc := range []struct {
		name string
		p    protocol.MetadataSetParams
	}{
		{"stale document", protocol.MetadataSetParams{DocumentID: "old", StateID: e.historyState.history.CurrentID()}},
		{"stale history", protocol.MetadataSetParams{DocumentID: e.doc.editor.documentID, StateID: initial.StateID}},
		{"unknown tag", protocol.MetadataSetParams{DocumentID: e.doc.editor.documentID, StateID: e.historyState.history.CurrentID(), Tags: map[string]string{"bogus": "x"}}},
		{"NUL", protocol.MetadataSetParams{DocumentID: e.doc.editor.documentID, StateID: e.historyState.history.CurrentID(), Tags: map[string]string{"title": "x\x00y"}}},
		{"invalid UTF8", protocol.MetadataSetParams{DocumentID: e.doc.editor.documentID, StateID: e.historyState.history.CurrentID(), Tags: map[string]string{"title": string([]byte{255})}}},
		{"oversized", protocol.MetadataSetParams{DocumentID: e.doc.editor.documentID, StateID: e.historyState.history.CurrentID(), Tags: map[string]string{"title": strings.Repeat("a", maxTagBytes+1)}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := e.metadataResult()
			if _, err := e.setMetadata(tc.p); err == nil {
				t.Fatal("accepted invalid metadata")
			}
			if !reflect.DeepEqual(before, e.metadataResult()) {
				t.Fatal("rejection changed metadata/history")
			}
		})
	}
}

func TestWAVMetadataPreservation(t *testing.T) {
	for _, edit := range []bool{false, true} {
		t.Run(map[bool]string{false: "unchanged", true: "edited"}[edit], func(t *testing.T) {
			e, input := metadataFixture(t)
			layout, err := inspectWAV(input)
			if err != nil {
				t.Fatal(err)
			}
			if edit {
				if _, err := e.setMetadata(protocol.MetadataSetParams{DocumentID: e.doc.editor.documentID, StateID: e.historyState.history.CurrentID(), Tags: map[string]string{"title": "New odd-size 🎵", "artist": "Artist"}}); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := e.exportDocument(protocol.DocumentExportParams{Format: "wav", BitDepth: 32, Float: true}); err != nil {
				t.Fatal(err)
			}
			output := slices.Clone(e.bulkData)
			exported, err := inspectWAV(output)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(input[layout.dataStart:layout.dataStart+layout.dataBytes], output[exported.dataStart:exported.dataStart+exported.dataBytes]) {
				t.Fatal("metadata export changed PCM bits")
			}
			for _, chunk := range layout.metadataChunks {
				if chunk.ID == wav.CIDList && edit {
					continue
				}
				found := false
				for _, candidate := range exported.metadataChunks {
					if candidate.ID == chunk.ID && bytes.Equal(candidate.Data, chunk.Data) {
						found = true
					}
				}
				if !found {
					t.Fatalf("lost %q payload", chunk.ID)
				}
			}
			if !bytes.Contains(output, timelineRIFFChunk("ZZZZ", []byte{9, 8, 7})) {
				t.Fatal("lost unknown INFO record")
			}
			reopened := New()
			if _, err := reopened.openWAVDocument(protocol.DocumentOpenParams{Name: "out.wav"}, output); err != nil {
				t.Fatal(err)
			}
			title := "Before"
			if edit {
				title = "New odd-size 🎵"
			}
			if reopened.doc.document.Metadata().Tags["title"] != title {
				t.Fatal("tag roundtrip failed")
			}
			if _, err := e.exportDocument(protocol.DocumentExportParams{Format: "flac", BitDepth: 16}); err == nil {
				t.Fatal("silently dropped metadata in FLAC")
			}
			e.doc.editor.selection = protocol.SelectionRange{Start: 1, End: 3, ChannelMask: 1}
			if _, err := e.exportDocument(protocol.DocumentExportParams{Format: "wav", BitDepth: 32, Float: true, Scope: "selection"}); err != nil {
				t.Fatal(err)
			}
			if bytes.Contains(e.bulkData, []byte("Broadcast description")) || bytes.Contains(e.bulkData, []byte("xtra")) {
				t.Fatal("partial export kept opaque original-file references")
			}
			selected, err := inspectWAV(e.bulkData)
			if err != nil {
				t.Fatal(err)
			}
			tags, err := wavTags(selected.metadataChunks)
			if err != nil || tags["title"] != title {
				t.Fatalf("partial export lost tags: %v, %v", tags, err)
			}
		})
	}
}

func TestWAVAssociatedMetadataSurvivesTimelineEdits(t *testing.T) {
	for _, cueID := range []uint32{0, 7} {
		t.Run(string(rune('0'+cueID)), func(t *testing.T) {
			e, _ := metadataFixture(t)
			if _, err := e.exportDocument(protocol.DocumentExportParams{Format: "wav", BitDepth: 32, Float: true}); err != nil {
				t.Fatal(err)
			}
			region := timelineRegion(cueID, 3, "Region text")
			binary.LittleEndian.PutUint16(region[20:], 44)
			binary.LittleEndian.PutUint16(region[22:], 9)
			binary.LittleEndian.PutUint16(region[24:], 2)
			binary.LittleEndian.PutUint16(region[26:], 1252)
			note := timelineLabel(cueID, "Note 🎵")
			copy(note, "note")
			input := wavWithTimeline(e.bulkData, true, timelineCue(cueID, 0), timelineADTL(timelineLabel(cueID, "Label"), note, region, timelineRIFFChunk("zzzz", []byte{4, 3, 2})))
			if _, err := e.openWAVDocument(protocol.DocumentOpenParams{Name: "associated.wav"}, input); err != nil {
				t.Fatal(err)
			}
			anchor := e.doc.document.Metadata().Timeline.Regions[0]
			if _, err := e.updateRegion(protocol.RegionUpdateParams{ID: anchor.ID, RegionAddParams: protocol.RegionAddParams{DocumentID: e.doc.editor.documentID, Start: 1, End: 3, Name: "Renamed", Color: anchor.Color}}); err != nil {
				t.Fatal(err)
			}
			if _, err := e.exportDocument(protocol.DocumentExportParams{Format: "wav", BitDepth: 32, Float: true}); err != nil {
				t.Fatal(err)
			}
			layout, err := inspectWAV(e.bulkData)
			if err != nil {
				t.Fatal(err)
			}
			decoder := wav.NewDecoder(bytes.NewReader(nil))
			for _, chunk := range layout.metadataChunks {
				if chunk.ID == wav.CIDList && string(chunk.Data[:4]) == "adtl" {
					if err := wav.DecodeAssociatedDataChunk(decoder, metadataChunk(chunk)); err != nil {
						t.Fatal(err)
					}
				}
			}
			associated := decoder.Metadata.AssociatedData
			if len(associated.Notes) != 1 || associated.Notes[0].Text != "Note 🎵" || associated.Notes[0].CuePointID != uint32(anchor.ID) {
				t.Fatalf("lost/remapped note: %#v", associated)
			}
			r := associated.Regions[0]
			if r.SampleLength != 2 || r.Country != 44 || r.Language != 9 || r.Dialect != 2 || r.CodePage != 1252 || r.Text != "Region text" {
				t.Fatalf("lost locale/text or stale length: %#v", r)
			}
			if associated.Labels[0].Text != "Renamed" || len(associated.UnknownSubchunks) != 1 {
				t.Fatal("lost renamed label/unknown record")
			}
			e.doc.editor.selection = protocol.SelectionRange{Start: 0, End: 2, ChannelMask: 1}
			if _, err := e.exportDocument(protocol.DocumentExportParams{Format: "wav", BitDepth: 32, Float: true, Scope: "selection"}); err != nil {
				t.Fatal(err)
			}
			selected := New()
			if _, err := selected.openWAVDocument(protocol.DocumentOpenParams{}, e.bulkData); err != nil {
				t.Fatal(err)
			}
			cropped := selected.doc.document.Metadata().Timeline.Regions[0]
			if cropped.Start != 1 || cropped.End != 2 {
				t.Fatalf("wrong cropped annotation: %#v", cropped)
			}
			if !bytes.Contains(e.bulkData, []byte("Note 🎵")) || bytes.Contains(e.bulkData, []byte("zzzz")) {
				t.Fatal("selection lost surviving note or retained opaque associated data")
			}
			if _, err := e.removeAnchor(protocol.MethodRegionsRemove, protocol.TimelineRemoveParams{DocumentID: e.doc.editor.documentID, ID: anchor.ID}); err != nil {
				t.Fatal(err)
			}
			if _, err := e.exportDocument(protocol.DocumentExportParams{Format: "wav", BitDepth: 32, Float: true}); err != nil {
				t.Fatal(err)
			}
			if bytes.Contains(e.bulkData, []byte("Note 🎵")) || bytes.Contains(e.bulkData, []byte("Region text")) {
				t.Fatal("deleted annotation left stale metadata")
			}
		})
	}
}

func TestWAVMetadataMalformedAndOwnership(t *testing.T) {
	e, input := metadataFixture(t)
	before := e.editResult(false)
	for _, chunk := range [][]byte{
		timelineRIFFChunk("LIST", []byte("bad")),
		timelineRIFFChunk("LIST", append([]byte("INFO"), []byte("INAM\xff\xff\xff\xff")...)),
		timelineRIFFChunk("bext", []byte{1, 2, 3}),
		timelineRIFFChunk("xtra", make([]byte, maxTimelineMetadataBytes+1)),
	} {
		if _, err := e.openWAVDocument(protocol.DocumentOpenParams{}, wavWithTimeline(input, true, chunk)); err == nil {
			t.Fatal("accepted malformed/oversized metadata")
		}
		if !reflect.DeepEqual(before, e.editResult(false)) {
			t.Fatal("failed import replaced document")
		}
	}
	metadata := e.doc.document.Metadata()
	metadata.WAVChunks[0].Data[0] = 99
	if e.doc.document.Metadata().WAVChunks[0].Data[0] == 99 {
		t.Fatal("metadata output aliases storage")
	}
	snapshot, err := e.doc.document.WithMetadata(metadata)
	if err != nil {
		t.Fatal(err)
	}
	metadata.WAVChunks[0].Data[0] = 100
	if snapshot.Metadata().WAVChunks[0].Data[0] != 99 {
		t.Fatal("metadata input aliases storage")
	}
}

func TestWAVLegacyInfoAndTagDeletion(t *testing.T) {
	e, _ := openEditorFixture(t, []float32{0.5, -0.5}, 1)
	if _, err := e.exportDocument(protocol.DocumentExportParams{Format: "wav", BitDepth: 32, Float: true}); err != nil {
		t.Fatal(err)
	}
	legacy := timelineRIFFChunk("INAM", []byte{0xe9, 0})
	payload := append([]byte("INFO"), legacy...)
	payload = append(payload, timelineRIFFChunk("IART", []byte("Old artist\x00"))...)
	input := wavWithTimeline(e.bulkData, false, timelineRIFFChunk("LIST", payload))
	if _, err := e.openWAVDocument(protocol.DocumentOpenParams{}, input); err != nil {
		t.Fatal(err)
	}
	if e.doc.document.Metadata().Tags["title"] != "é" {
		t.Fatal("legacy INFO display fallback failed")
	}
	if _, err := e.setMetadata(protocol.MetadataSetParams{DocumentID: e.doc.editor.documentID, StateID: e.historyState.history.CurrentID(), Tags: map[string]string{"title": "é", "artist": "New artist"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.exportDocument(protocol.DocumentExportParams{Format: "wav", BitDepth: 32, Float: true}); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(e.bulkData, legacy) {
		t.Fatal("editing another field rewrote legacy INFO bytes")
	}
	if _, err := e.setMetadata(protocol.MetadataSetParams{DocumentID: e.doc.editor.documentID, StateID: e.historyState.history.CurrentID(), Tags: map[string]string{"artist": "New artist", "title": ""}}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.exportDocument(protocol.DocumentExportParams{Format: "wav", BitDepth: 32, Float: true}); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(e.bulkData, []byte("INAM")) {
		t.Fatal("deleted tag reappeared in output")
	}
	reopened := New()
	if _, err := reopened.openWAVDocument(protocol.DocumentOpenParams{}, e.bulkData); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(reopened.doc.document.Metadata().Tags, map[string]string{"artist": "New artist"}) {
		t.Fatal("tag deletion changed other fields")
	}
}
