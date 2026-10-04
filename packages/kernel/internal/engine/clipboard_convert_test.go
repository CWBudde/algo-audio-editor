package engine

import (
	"fmt"
	"math"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/ops"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func sampleClipboard(t *testing.T, samples [][]float32, rate int) ops.Clipboard {
	t.Helper()
	channels := make([]audiobuf.Channel, len(samples))
	for i, values := range samples {
		channels[i] = audiobuf.NewChannel(values)
	}
	doc, err := audiobuf.NewDocument(channels, rate, audiobuf.Metadata{})
	if err != nil {
		t.Fatal(err)
	}
	clip, err := ops.NewClipboard(doc, ops.Range{End: doc.Frames(), ChannelMask: (1 << len(channels)) - 1})
	if err != nil {
		t.Fatal(err)
	}
	return clip
}

func TestClipboardConversionRatesDurationTailAndDC(t *testing.T) {
	for _, rates := range [][2]int{{44100, 48000}, {48000, 44100}, {8000, 384000}, {384000, 8000}, {48000, 96000}, {96000, 48000}} {
		for _, frames := range []int{1, 7, 2113, 65539} {
			t.Run(fmt.Sprintf("%d-%d/%d", rates[0], rates[1], frames), func(t *testing.T) {
				input := make([]float32, frames)
				for i := range input {
					input[i] = float32(.2 + .1*math.Sin(float64(i)*.07))
				}
				input[len(input)-1] = 1 // Ensure the finite tail is not omitted.
				clip := sampleClipboard(t, [][]float32{input}, rates[0])
				converted, err := convertClipboard(clip, rates[1], 1)
				if err != nil {
					t.Fatal(err)
				}
				count := (frames*rates[1] + rates[0] - 1) / rates[0]
				if converted.Frames() != int64(count) || converted.SampleRate() != rates[1] {
					t.Fatal("duration/format mismatch")
				}
				got := make([]float32, count)
				if converted.Read(got, 0, 0) != count {
					t.Fatal("short read")
				}
				assertEditBits(t, got, directResampled(t, input, rates[0], rates[1], count))
				original := make([]float32, frames)
				clip.Read(original, 0, 0)
				assertEditBits(t, original, input)
			})
		}
		constant := make([]float32, 4096)
		for i := range constant {
			constant[i] = .25
		}
		converted, err := convertClipboard(sampleClipboard(t, [][]float32{constant}, rates[0]), rates[1], 1)
		if err != nil {
			t.Fatal(err)
		}
		middle := make([]float32, 16)
		converted.Read(middle, 0, converted.Frames()/2)
		for _, v := range middle {
			if math.Abs(float64(v)-.25) > 0.001 {
				t.Fatalf("DC %v for %v", v, rates)
			}
		}
	}
}

func TestClipboardChannelRoutingOneThroughEight(t *testing.T) {
	for source := 1; source <= 8; source++ {
		for target := 1; target <= 8; target++ {
			values := make([][]float32, source)
			for c := range values {
				values[c] = []float32{float32(c + 1), float32((c + 1) * 2)}
			}
			clip := sampleClipboard(t, values, 48000)
			converted, err := convertClipboard(clip, 48000, target)
			if err != nil {
				t.Fatal(err)
			}
			for c := range target {
				got := make([]float32, 2)
				converted.Read(got, c, 0)
				want := float64(c%source + 1)
				if target < source {
					sum, count := float64(0), 0
					for s := c; s < source; s += target {
						sum += float64(s + 1)
						count++
					}
					want = sum / float64(count)
				}
				assertEditBits(t, got, []float32{float32(want), float32(want * 2)})
			}
		}
	}
}

func TestPasteConversionConfirmationVersionAndTargetFrames(t *testing.T) {
	e, _ := openEditorFixture(t, []float32{1, 10, 2, 20, 3, 30}, 2)
	if _, err := e.applyEdit(editParams(e, "copy", 0, 3, 1)); err != nil {
		t.Fatal(err)
	}
	planParams := protocol.PreparePasteParams{DocumentID: e.editor.documentID, ChannelMask: 3, ClipboardVersion: e.clipboardInfo().Version}
	plan, err := e.preparePaste(planParams)
	if err != nil {
		t.Fatal(err)
	}
	if !plan.ConversionRequired || plan.SourceChannels != 1 || plan.TargetChannels != 2 || plan.Frames != 3 {
		t.Fatalf("plan %+v", plan)
	}
	p := editParams(e, "paste-insert", 3, 3, 3)
	before := e.editResult(false)
	if _, err := e.applyEdit(p); err == nil {
		t.Fatal("mono broadcast without confirmation")
	}
	if !reflectEditResultEqual(before, e.editResult(false)) {
		t.Fatal("failed conversion mutated state")
	}
	p.Convert = true
	result, err := e.applyEdit(p)
	if err != nil {
		t.Fatal(err)
	}
	if result.Clipboard != before.Clipboard {
		t.Fatal("converted paste replaced original clipboard")
	}
	assertEditBits(t, editSamples(t, e), []float32{1, 10, 2, 20, 3, 30, 1, 1, 2, 2, 3, 3})
	// Opening a different rate preserves the original clipboard; plan duration
	// describes target frames, not source frames.
	if _, err := e.openDocument(protocol.DocumentOpenParams{}, rawWAV(3, 32, 1, 96000, floatPayload(32, []float64{0}), false)); err != nil {
		t.Fatal(err)
	}
	planParams.DocumentID, planParams.ChannelMask = e.editor.documentID, 1
	plan, err = e.preparePaste(planParams)
	if err != nil || plan.Frames != 6 || !plan.ConversionRequired {
		t.Fatalf("rate plan %+v %v", plan, err)
	}
	if !editorCall(t, e, protocol.MethodPreparePaste, planParams).OK {
		t.Fatal("prepare dispatch failed")
	}
	p = editParams(e, "paste-replace", 0, 1, 1)
	p.Convert = true
	if _, err = e.applyEdit(p); err != nil {
		t.Fatal(err)
	}
	assertEditBits(t, editSamples(t, e), directResampled(t, []float32{1, 2, 3}, 48000, 96000, 6))
}

func reflectEditResultEqual(a, b protocol.EditResult) bool {
	return a.Document == b.Document && a.Selection == b.Selection && a.Clipboard == b.Clipboard && a.Changed == b.Changed
}

func TestClipboardConversionBudgetsAndFrameOverflow(t *testing.T) {
	if _, err := clipboardOutputFrames(maxEditorFrame, 8000, 384000); err == nil {
		t.Fatal("JS duration overflow accepted")
	}
	for _, frames := range []int64{0, -1, maxEditorFrame + 1} {
		if _, err := clipboardOutputFrames(frames, 48000, 48000); err == nil {
			t.Fatal("invalid duration accepted")
		}
	}
	// A huge logical clip is structural sharing of one tiny immutable block.
	block, err := audiobuf.NewBlock(make([]float32, audiobuf.BlockFrames))
	if err != nil {
		t.Fatal(err)
	}
	blocks := make([]*audiobuf.Block, 1024)
	for i := range blocks {
		blocks[i] = block
	}
	channel, err := audiobuf.NewChannelFromBlocks(blocks)
	if err != nil {
		t.Fatal(err)
	}
	for channel.Frames() < maxConvertedSampleBytes/4+1 {
		channel = channel.Concat(channel)
	}
	doc, err := audiobuf.NewDocument([]audiobuf.Channel{channel}, 48000, audiobuf.Metadata{})
	if err != nil {
		t.Fatal(err)
	}
	clip, err := ops.NewClipboard(doc, ops.Range{End: doc.Frames(), ChannelMask: 1})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := convertClipboard(clip, 48000, 1); err != nil {
		t.Fatalf("same-format sharing must not be capped: %v", err)
	}
	if _, err := convertClipboard(clip, 48000, 2); err == nil {
		t.Fatal("materialized output budget ignored")
	}
	if _, err := convertClipboard(sampleClipboard(t, [][]float32{{1}}, 383999), 384000, 1); err == nil {
		t.Fatal("coprime filter workspace budget ignored")
	}
}
