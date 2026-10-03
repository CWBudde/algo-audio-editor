package engine

import (
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func editParams(e *Engine, operation string, start, end int64, mask int) protocol.EditApplyParams {
	return protocol.EditApplyParams{SelectionResult: protocol.SelectionResult{DocumentID: e.editor.documentID, SelectionRange: protocol.SelectionRange{Start: start, End: end, ChannelMask: mask}}, Operation: operation, ClipboardVersion: e.clipboardInfo().Version}
}

func editSamples(t *testing.T, e *Engine) []float32 {
	t.Helper()
	out := make([]float32, int(e.document.Frames())*e.document.Channels())
	mono := make([]float32, int(e.document.Frames()))
	for c := range e.document.Channels() {
		channel, err := e.document.Channel(c)
		if err != nil {
			t.Fatal(err)
		}
		if channel.Read(mono, 0) != len(mono) {
			t.Fatal("short read")
		}
		for i, sample := range mono {
			out[i*e.document.Channels()+c] = sample
		}
	}
	return out
}

func assertEditBits(t *testing.T, got, want []float32) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("length %d != %d; samples %v", len(got), len(want), got)
	}
	for i := range want {
		if math.Float32bits(got[i]) != math.Float32bits(want[i]) {
			t.Fatalf("sample %d: %v != %v", i, got[i], want[i])
		}
	}
}

func TestEditsAllOperationsExportReimport(t *testing.T) {
	for _, tc := range []struct {
		operation  string
		start, end int64
		mask       int
		want       []float32
	}{
		{"delete", 1, 3, 3, []float32{1, 10, 4, 40}},
		{"cut", 1, 3, 3, []float32{1, 10, 4, 40}},
		{"copy", 1, 3, 1, []float32{1, 10, 2, 20, 3, 30, 4, 40}},
		{"crop", 1, 3, 1, []float32{2, 20, 3, 30}},
		{"mute", 1, 3, 1, []float32{1, 10, 0, 20, 0, 30, 4, 40}},
		{"duplicate", 1, 3, 3, []float32{1, 10, 2, 20, 3, 30, 2, 20, 3, 30, 4, 40}},
		{"insert-silence", 1, 3, 3, []float32{1, 10, 0, 0, 0, 0, 2, 20, 3, 30, 4, 40}},
		{"swap-channels", 1, 3, 3, []float32{1, 10, 20, 2, 30, 3, 4, 40}},
		{"paste-insert", 1, 3, 3, []float32{1, 10, 1, 10, 2, 20, 2, 20, 3, 30, 4, 40}},
		{"paste-replace", 1, 3, 3, []float32{1, 10, 1, 10, 2, 20, 4, 40}},
		{"paste-mix", 1, 3, 3, []float32{1, 10, 3, 30, 5, 50, 4, 40}},
	} {
		t.Run(tc.operation, func(t *testing.T) {
			e, id := openEditorFixture(t, []float32{1, 10, 2, 20, 3, 30, 4, 40}, 2)
			if _, err := e.applyEdit(editParams(e, "copy", 0, 2, 3)); err != nil {
				t.Fatal(err)
			}
			playRange(t, e, 0, 4, true)
			p := editParams(e, tc.operation, tc.start, tc.end, tc.mask)
			duration := int64(2)
			p.Frames = &duration
			result, err := e.applyEdit(p)
			if err != nil {
				t.Fatal(err)
			}
			changed := tc.operation != "copy"
			if result.Changed != changed || (result.Document.DocumentID != id) != changed {
				t.Fatalf("identity/result %+v", result)
			}
			if changed && (e.transport != nil || e.source != sourceStopped) {
				t.Fatal("mutation did not invalidate transport")
			}
			if !changed && (e.transport == nil || !e.transport.playing) {
				t.Fatal("copy stopped playback")
			}
			if result.Document.Name != "editor.wav" || result.Document.BitDepth != 32 || !result.Document.Float {
				t.Fatal("metadata changed")
			}
			assertEditBits(t, editSamples(t, e), tc.want)
			if _, err := e.exportDocument(protocol.DocumentExportParams{Format: "wav", BitDepth: 32, Float: true}); err != nil {
				t.Fatal(err)
			}
			other := New()
			if _, err := other.openDocument(protocol.DocumentOpenParams{}, e.TakeData()); err != nil {
				t.Fatal(err)
			}
			assertEditBits(t, editSamples(t, other), tc.want)
		})
	}
}

func TestEditClipboardIdentityMemoryAndOpenSurvival(t *testing.T) {
	e, id := openEditorFixture(t, []float32{1, 2, 3, 4}, 1)
	before := e.documentMemory()
	copyResult, err := e.applyEdit(editParams(e, "copy", 1, 3, 1))
	if err != nil {
		t.Fatal(err)
	}
	if copyResult.Changed || copyResult.Document.DocumentID != id || e.documentMemory().SampleBytes != before.SampleBytes {
		t.Fatal("copy duplicated samples or identity")
	}
	version := e.clipboardInfo().Version
	if _, err := e.openDocument(protocol.DocumentOpenParams{}, []byte("bad")); err == nil {
		t.Fatal("invalid open succeeded")
	}
	if e.clipboardInfo().Version != version {
		t.Fatal("failed open cleared clipboard")
	}
	if _, err := e.openDocument(protocol.DocumentOpenParams{Name: "new.wav"}, rawWAV(3, 32, 1, 48000, floatPayload(32, []float64{9}), false)); err != nil {
		t.Fatal(err)
	}
	if e.clipboardInfo().Version != version || e.documentMemory().SampleBytes != 20 {
		t.Fatalf("clipboard survival/accounting %+v", e.documentMemory())
	}
	p := editParams(e, "paste-insert", 1, 1, 1)
	if _, err := e.applyEdit(p); err != nil {
		t.Fatal(err)
	}
	assertEditBits(t, editSamples(t, e), []float32{9, 2, 3})
	if _, err := e.applyEdit(editParams(e, "copy", 0, 1, 1)); err != nil {
		t.Fatal(err)
	}
	p.DocumentID = e.editor.documentID
	if _, err := e.applyEdit(p); err == nil {
		t.Fatal("stale clipboard accepted")
	}
}

func TestEditFailuresAndNoopsAreAtomic(t *testing.T) {
	for _, operation := range []string{"delete", "mute", "duplicate"} {
		e, id := openEditorFixture(t, []float32{1, 2}, 1)
		if _, err := e.configure(protocol.EngineConfigureParams{SampleRate: 48000, Channels: 1}); err != nil {
			t.Fatal(err)
		}
		playRange(t, e, 0, 2, true)
		result, err := e.applyEdit(editParams(e, operation, 1, 1, 1))
		if err != nil || result.Changed || result.Document.DocumentID != id || !e.transport.playing {
			t.Fatalf("no-op %s %+v %v", operation, result, err)
		}
	}
	e, _ := openEditorFixture(t, []float32{1, 2, 3, 4}, 2)
	if _, err := e.applyEdit(editParams(e, "copy", 0, 1, 1)); err != nil {
		t.Fatal(err)
	}
	e.editor.markers = []protocol.TimelineMarker{{ID: 1, Frame: 2, Name: "end"}}
	e.editor.regions = []protocol.TimelineRegion{{ID: 2, Start: 1, End: 2, Name: "tail"}}
	playRange(t, e, 0, 2, true)
	bad := []protocol.EditApplyParams{editParams(e, "unknown", 0, 1, 3), editParams(e, "cut", 1, 1, 3), editParams(e, "crop", 1, 1, 3), editParams(e, "swap-channels", 0, 1, 1), editParams(e, "insert-silence", 0, 0, 3), editParams(e, "paste-insert", 0, 0, 3)}
	p := editParams(e, "mute", 0, 1, 3)
	p.DocumentID = "stale"
	bad = append(bad, p)
	p = editParams(e, "mute", 0, 3, 3)
	bad = append(bad, p)
	p = editParams(e, "mute", 0, 1, 4)
	bad = append(bad, p)
	for _, p := range bad {
		before := e.editResult(false)
		transport := e.transport
		if _, err := e.applyEdit(p); err == nil {
			t.Fatalf("accepted invalid %+v", p)
		}
		if !reflect.DeepEqual(e.editResult(false), before) || e.transport != transport || !e.transport.playing {
			t.Fatalf("error mutated state %+v", p)
		}
		assertEditBits(t, editSamples(t, e), []float32{1, 2, 3, 4})
	}
	e.documentSequence = math.MaxUint64
	if _, err := e.applyEdit(editParams(e, "cut", 0, 1, 3)); err == nil {
		t.Fatal("identity overflow accepted")
	}
	if e.clipboardInfo().Channels != 1 {
		t.Fatal("failed cut replaced clipboard")
	}
}

func TestEditSelectionAndAnchorClamp(t *testing.T) {
	e, _ := openEditorFixture(t, []float32{1, 2, 3, 4}, 1)
	e.editor.selection = protocol.SelectionRange{Start: 0, End: 1, ChannelMask: 1}
	e.editor.markers = []protocol.TimelineMarker{{ID: 1, Frame: 4, Name: "end"}}
	e.editor.regions = []protocol.TimelineRegion{{ID: 2, Start: 3, End: 4, Name: "drop"}, {ID: 3, Start: 1, End: 4, Name: "keep"}}
	r, err := e.applyEdit(editParams(e, "delete", 2, 4, 1))
	if err != nil {
		t.Fatal(err)
	}
	if r.Selection.Start != 2 || r.Selection.End != 2 || r.Timeline.Markers[0].Frame != 2 || len(r.Timeline.Regions) != 1 || r.Timeline.Regions[0].ID != 3 || r.Timeline.Regions[0].End != 2 {
		t.Fatalf("explicit selection/anchor policy %+v", r)
	}
	if editorCall(t, e, protocol.MethodSelectionGet, protocol.SelectionGetParams{DocumentID: "doc-1"}).OK {
		t.Fatal("old identity accepted")
	}
	if !editorCall(t, e, protocol.MethodEditState, nil).OK || !editorCall(t, e, protocol.MethodEditApply, editParams(e, "mute", 0, 0, 1)).OK {
		t.Fatal("edit dispatch failed")
	}
}

func TestEditEightChannelSubsetAndCollapsedSwap(t *testing.T) {
	samples := make([]float32, 3*8)
	for i := range samples {
		samples[i] = float32(i + 1)
	}
	e, _ := openEditorFixture(t, samples, 8)
	if _, err := e.applyEdit(editParams(e, "copy", 1, 2, 0x81)); err != nil {
		t.Fatal(err)
	}
	if e.clipboardInfo().Channels != 2 {
		t.Fatal("clipboard channels not packed")
	}
	p := editParams(e, "paste-insert", 1, 1, 0x18)
	if _, err := e.applyEdit(p); err != nil {
		t.Fatal(err)
	}
	want := make([]float32, 4*8)
	copy(want, samples)
	// Only selected targets ripple; every other channel is unchanged with EOF padding.
	for _, c := range []int{3, 4} {
		want[8+c], want[16+c], want[24+c] = samples[8], samples[8+c], samples[16+c]
	}
	want[8+4] = samples[15]
	assertEditBits(t, editSamples(t, e), want)
	before := editSamples(t, e)
	if _, err := e.applyEdit(editParams(e, "swap-channels", 4, 4, 0x81)); err != nil {
		t.Fatal(err)
	}
	for f := range 4 {
		before[f*8], before[f*8+7] = before[f*8+7], before[f*8]
	}
	assertEditBits(t, editSamples(t, e), before)
}

func TestEditSpecialFloatCopyAndIntegerMetadata(t *testing.T) {
	values := []float32{math.Float32frombits(0x80000000), math.Float32frombits(0x7fc12345), math.Float32frombits(0x7f800000), math.Float32frombits(1), 2}
	e, _ := openEditorFixture(t, values, 1)
	if _, err := e.applyEdit(editParams(e, "copy", 0, int64(len(values)), 1)); err != nil {
		t.Fatal(err)
	}
	if _, err := e.applyEdit(editParams(e, "paste-insert", int64(len(values)), int64(len(values)), 1)); err != nil {
		t.Fatal(err)
	}
	assertEditBits(t, editSamples(t, e), append(append([]float32{}, values...), values...))
	if _, err := e.openDocument(protocol.DocumentOpenParams{Name: "integer.wav"}, rawWAV(1, 16, 1, 48000, intPayload(16, []int32{1, 2, 3}), false)); err != nil {
		t.Fatal(err)
	}
	r, err := e.applyEdit(editParams(e, "mute", 0, 1, 1))
	if err != nil {
		t.Fatal(err)
	}
	if r.Document.BitDepth != 16 || r.Document.Float || r.Document.Name != "integer.wav" {
		t.Fatalf("source format changed %+v", r.Document)
	}
	if _, err := e.exportDocument(protocol.DocumentExportParams{Format: "wav", BitDepth: r.Document.BitDepth, Float: r.Document.Float}); err != nil {
		t.Fatal(err)
	}
	other := New()
	if _, err := other.openDocument(protocol.DocumentOpenParams{}, e.TakeData()); err != nil {
		t.Fatal(err)
	}
	assertEditBits(t, editSamples(t, other), editSamples(t, e))
}

func TestEditMixMaterializedBudgetFailureIsAtomic(t *testing.T) {
	e, _ := openEditorFixture(t, []float32{1, 10, 2, 20, 3, 30, 4, 40}, 2)
	// The logical clipboard exceeds the output budget, but shared zero blocks
	// retain only one full block plus a one-sample tail, not 512 MiB of audio.
	silence, err := audiobuf.NewSilence(maxConvertedSampleBytes/4 + 1)
	if err != nil {
		t.Fatal(err)
	}
	document, err := audiobuf.NewDocument([]audiobuf.Channel{silence, silence}, 48000, audiobuf.Metadata{})
	if err != nil {
		t.Fatal(err)
	}
	e.clipboard, err = ops.NewClipboard(document, ops.Range{End: document.Frames(), ChannelMask: 3})
	if err != nil {
		t.Fatal(err)
	}
	e.clipboardSequence = 1
	e.editor.selection = protocol.SelectionRange{Start: 2, End: 4, ChannelMask: 2}
	e.editor.markers = []protocol.TimelineMarker{{ID: 1, Frame: 4, Name: "end"}}
	e.editor.regions = []protocol.TimelineRegion{{ID: 2, Start: 1, End: 4, Name: "keep"}}
	playRange(t, e, 1, 4, true)
	before := e.editResult(false)
	beforeMemory := e.documentMemory()
	transport, position := e.transport, e.transport.result()
	source, documentSequence, clipboardSequence := e.source, e.documentSequence, e.clipboardSequence
	response := editorCall(t, e, protocol.MethodEditApply, editParams(e, "paste-mix", 0, 1, 3))
	if response.OK || !strings.Contains(response.Error, "budget") {
		t.Fatalf("expected mix budget error, got %+v", response)
	}
	if !reflect.DeepEqual(before, e.editResult(false)) || e.documentMemory() != beforeMemory {
		t.Fatal("mix budget failure changed document/selection/anchors/clipboard/storage")
	}
	if e.transport != transport || e.transport.result() != position || !e.transport.playing || e.source != source {
		t.Fatal("mix budget failure changed active transport")
	}
	if e.documentSequence != documentSequence || e.clipboardSequence != clipboardSequence {
		t.Fatal("mix budget failure consumed an identity")
	}
	assertEditBits(t, editSamples(t, e), []float32{1, 10, 2, 20, 3, 30, 4, 40})
}
