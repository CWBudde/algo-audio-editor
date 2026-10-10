package engine

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func TestNewDocumentCreatesCleanSilence(t *testing.T) {
	for _, test := range []struct {
		name   string
		params protocol.DocumentNewParams
		want   string
	}{
		{"empty stereo", protocol.DocumentNewParams{SampleRate: 48000, Channels: 2}, "Untitled"},
		{"named mono", protocol.DocumentNewParams{Name: "Voice", SampleRate: 44100, Channels: 1, Frames: 3 * audiobuf.BlockFrames / 2}, "Voice"},
		{"eight channels", protocol.DocumentNewParams{SampleRate: 96000, Channels: 8, Frames: 1}, "Untitled"},
	} {
		t.Run(test.name, func(t *testing.T) {
			e := New()
			info, err := e.newDocument(test.params)
			if err != nil {
				t.Fatal(err)
			}
			if info.Name != test.want || info.SampleRate != test.params.SampleRate || info.Channels != test.params.Channels ||
				info.Frames != test.params.Frames || info.BitDepth != 32 || !info.Float || info.Format != "" {
				t.Fatalf("info %+v", info)
			}
			for _, sample := range editSamples(t, e) {
				if sample != 0 {
					t.Fatalf("new document holds %g, want silence", sample)
				}
			}
			history, err := e.listHistory(protocol.HistoryListParams{DocumentID: info.DocumentID})
			if err != nil || history.Dirty || history.CanUndo || len(history.Entries) != 1 {
				t.Fatalf("history %+v %v", history, err)
			}
			selection := e.doc.editor.selection
			if selection.Start != 0 || selection.End != 0 || selection.ChannelMask != 1<<test.params.Channels-1 {
				t.Fatalf("selection %+v", selection)
			}
		})
	}
}

func TestNewDocumentReplacesTheOpenDocumentAndItsState(t *testing.T) {
	e, _ := openEditorFixture(t, []float32{.5, -.5, .25, -.25}, 2)
	before := e.doc.editor.documentID
	if _, err := e.playDocument(protocol.TransportPlayParams{}); err != nil {
		t.Fatal(err)
	}
	info, err := e.newDocument(protocol.DocumentNewParams{SampleRate: 22050, Channels: 1, Frames: 10})
	if err != nil {
		t.Fatal(err)
	}
	if info.DocumentID == before || e.playback.transport != nil || e.analysis.analysisJob != nil {
		t.Fatalf("old state survived: %+v transport=%v", info, e.playback.transport)
	}
	if _, err := e.listHistory(protocol.HistoryListParams{DocumentID: before}); err == nil {
		t.Fatal("old document identity still answers")
	}
}

func TestNewDocumentRejectsInvalidFormatsWithoutReplacing(t *testing.T) {
	e, _ := openEditorFixture(t, []float32{.5, -.5}, 1)
	before := e.doc.editor.documentID
	for _, params := range []protocol.DocumentNewParams{
		{SampleRate: MinSampleRate - 1, Channels: 1},
		{SampleRate: MaxSampleRate + 1, Channels: 1},
		{SampleRate: 48000, Channels: 0},
		{SampleRate: 48000, Channels: MaxChannels + 1},
		{SampleRate: 48000, Channels: 1, Frames: -1},
		{SampleRate: 48000, Channels: 1, Frames: maxEditorFrame + 1},
		// More shared zero blocks than a channel may reference.
		{SampleRate: 48000, Channels: 1, Frames: (1<<20 + 1) * audiobuf.BlockFrames},
	} {
		if _, err := e.newDocument(params); err == nil {
			t.Fatalf("accepted %+v", params)
		}
		if e.doc.editor.documentID != before {
			t.Fatalf("rejected %+v replaced the document", params)
		}
	}
}

func TestNewDocumentIsChargedAgainstTheStorageBudget(t *testing.T) {
	e := New()
	e.memory.limit = 1 << 10
	if _, err := e.newDocument(protocol.DocumentNewParams{SampleRate: 48000, Channels: 2, Frames: 48000}); err == nil ||
		!strings.Contains(err.Error(), "memory budget") {
		t.Fatalf("over-budget silence accepted: %v", err)
	}
}

func TestNewDocumentWireMethodIsStrict(t *testing.T) {
	e := New()
	var response protocol.Response
	if err := json.Unmarshal(e.Call(protocol.MethodDocumentNew, []byte(`{"sampleRate":48000,"channels":2,"frames":480}`)), &response); err != nil || response.Error != "" {
		t.Fatalf("doc.new failed: %+v %v", response, err)
	}
	response = protocol.Response{}
	if err := json.Unmarshal(e.Call(protocol.MethodDocumentNew, []byte(`{"sampleRate":48000,"channels":2,"frame":480}`)), &response); err != nil || response.Error == "" {
		t.Fatalf("misspelled field accepted: %+v %v", response, err)
	}
}
