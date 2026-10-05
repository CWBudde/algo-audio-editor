package engine

import (
	"encoding/binary"
	"encoding/json"
	"math"
	"reflect"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func TestReadPCMSourcePages(t *testing.T) {
	samples := make([]float32, (audiobuf.BlockFrames+7)*3)
	for i := range samples {
		samples[i] = float32(i%113-56) / 64
	}
	samples[audiobuf.BlockFrames*3+3] = math.Float32frombits(0x80000000)
	e, id := openEditorFixture(t, samples, 3)
	beforeHistory, beforeSelection := e.historyResult(), e.selectionResult()
	for _, tt := range []struct {
		start        int64
		frames, mask int
	}{{0, 8192, 7}, {audiobuf.BlockFrames - 3, 10, 5}, {audiobuf.BlockFrames + 1, 6, 2}} {
		p := protocol.PCMReadParams{DocumentID: id, StateID: e.historyState.history.CurrentID(), Start: tt.start, Frames: tt.frames, ChannelMask: tt.mask}
		response := editorCall(t, e, protocol.MethodDocumentReadPCM, p)
		var info protocol.PCMReadInfo
		if !response.OK || json.Unmarshal(response.Result, &info) != nil {
			t.Fatal(response)
		}
		data := e.TakeData()
		packed := 0
		for ch := range 3 {
			if tt.mask&(1<<ch) == 0 {
				continue
			}
			for i := range tt.frames {
				want := math.Float32bits(samples[(int(tt.start)+i)*3+ch])
				got := binary.LittleEndian.Uint32(data[(packed*tt.frames+i)*4:])
				if got != want {
					t.Fatalf("frame %d channel %d: %x != %x", i, ch, got, want)
				}
			}
			packed++
		}
		if info.Channels != packed || info.Frames != tt.frames || info.SampleRate != 48000 || info.DataBytes != len(data) {
			t.Fatal(info)
		}
	}
	if !reflect.DeepEqual(beforeHistory, e.historyResult()) || beforeSelection != e.selectionResult() {
		t.Fatal("read changed history/selection")
	}
}

func TestReadPCMRejectsInvalidAndStalePages(t *testing.T) {
	e, id := openEditorFixture(t, []float32{0, 1, 2, 3}, 2)
	valid := protocol.PCMReadParams{DocumentID: id, StateID: e.historyState.history.CurrentID(), Frames: 2, ChannelMask: 3}
	for _, tt := range []struct {
		name   string
		change func(*protocol.PCMReadParams)
	}{
		{"identity", func(p *protocol.PCMReadParams) { p.DocumentID = "old" }},
		{"state", func(p *protocol.PCMReadParams) { p.StateID = "old" }},
		{"missing state", func(p *protocol.PCMReadParams) { p.StateID = "" }},
		{"negative", func(p *protocol.PCMReadParams) { p.Start = -1 }},
		{"overflow", func(p *protocol.PCMReadParams) { p.Start = math.MaxInt64 }},
		{"EOF", func(p *protocol.PCMReadParams) { p.Start = 1 }},
		{"empty", func(p *protocol.PCMReadParams) { p.Frames = 0 }},
		{"oversize", func(p *protocol.PCMReadParams) { p.Frames = 8193 }},
		{"mask", func(p *protocol.PCMReadParams) { p.ChannelMask = 4 }},
		{"zero mask", func(p *protocol.PCMReadParams) { p.ChannelMask = 0 }},
	} {
		t.Run(tt.name, func(t *testing.T) {
			p := valid
			tt.change(&p)
			if editorCall(t, e, protocol.MethodDocumentReadPCM, p).OK || len(e.TakeData()) != 0 {
				t.Fatal("invalid read succeeded")
			}
		})
	}
	// An edit without replacing document identity still invalidates the state guard.
	if _, err := e.addMarker(protocol.MarkerAddParams{DocumentID: id, Frame: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.readPCM(valid); err == nil {
		t.Fatal("stale history accepted")
	}
	for _, value := range []float32{float32(math.NaN()), float32(math.Inf(1)), float32(math.Inf(-1))} {
		e, id := openEditorFixture(t, []float32{value, 1}, 2)
		p := protocol.PCMReadParams{DocumentID: id, StateID: e.historyState.history.CurrentID(), Frames: 1, ChannelMask: 1}
		if editorCall(t, e, protocol.MethodDocumentReadPCM, p).OK || len(e.TakeData()) != 0 {
			t.Fatal("nonfinite PCM returned")
		}
		p.ChannelMask = 2
		if !editorCall(t, e, protocol.MethodDocumentReadPCM, p).OK {
			t.Fatal("unselected invalid sample blocked read")
		}
	}
}
