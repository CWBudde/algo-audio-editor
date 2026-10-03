package engine

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"math"
	"math/rand/v2"
	"reflect"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func TestSelectionExportPackedChannelsCroppedAnnotationsAndImmutableHistory(t *testing.T) {
	input := []float32{1, 10, 100, 2, 20, 200, 3, 30, 300, 4, 40, 400, 5, 50, 500, 6, 60, 600}
	e, id := openEditorFixture(t, input, 3)
	setTimelineFixture(t, e,
		[]protocol.TimelineMarker{{ID: 1, Frame: 0, Name: "before"}, {ID: 2, Frame: 1, Name: "start"}, {ID: 3, Frame: 5, Name: "end"}, {ID: 4, Frame: 6, Name: "after"}},
		[]protocol.TimelineRegion{{ID: 5, Start: 0, End: 3, Name: "left"}, {ID: 6, Start: 3, End: 6, Name: "right"}})
	if _, err := e.setSelection(protocol.SelectionSetParams{DocumentID: id, SelectionRange: protocol.SelectionRange{Start: 1, End: 5, ChannelMask: 5}}); err != nil {
		t.Fatal(err)
	}
	before := e.editResult(false)
	info, err := e.exportDocument(protocol.DocumentExportParams{Format: "wav", BitDepth: 32, Float: true, Scope: "selection", DocumentID: id})
	if err != nil {
		t.Fatal(err)
	}
	if info.Name != "editor-selection.wav" {
		t.Fatalf("selection filename %q", info.Name)
	}
	data := e.TakeData()
	if info.DataBytes != len(data) {
		t.Fatal("wrong binary result length")
	}
	reopened := New()
	if _, err := reopened.openDocument(protocol.DocumentOpenParams{Name: info.Name}, data); err != nil {
		t.Fatal(err)
	}
	assertEditBits(t, editSamples(t, reopened), []float32{2, 200, 3, 300, 4, 400, 5, 500})
	if reopened.document.Frames() != 4 || reopened.document.Channels() != 2 || reopened.document.SampleRate() != 48000 {
		t.Fatal("selection output geometry")
	}
	timeline := reopened.document.Metadata().Timeline
	if len(timeline.Markers) != 2 || timeline.Markers[0].Frame != 0 || timeline.Markers[1].Frame != 4 || timeline.Markers[1].Name != "end" || len(timeline.Regions) != 2 || timeline.Regions[0].Start != 0 || timeline.Regions[0].End != 2 || timeline.Regions[1].Start != 2 || timeline.Regions[1].End != 4 {
		t.Fatalf("selection annotations not cropped/rebased: %+v", timeline)
	}
	clear(data)
	assertEditBits(t, editSamples(t, e), input)
	if !reflect.DeepEqual(before, e.editResult(false)) {
		t.Fatal("copy export changed selection, source, saved state or history")
	}
}

func TestExportScopeDefaultsValidationAndFiniteSelectionProof(t *testing.T) {
	input := []float32{math.Float32frombits(0x7f812345), .25, .5, float32(math.Inf(1))}
	e, id := openEditorFixture(t, input, 1)
	e.editor.selection = protocol.SelectionRange{Start: 1, End: 3, ChannelMask: 1}
	before := e.editResult(false)
	for _, params := range []protocol.DocumentExportParams{
		{Format: "wav", BitDepth: 16},
		{Format: "wav", BitDepth: 32, Float: true, Scope: "unknown"},
		{Format: "wav", BitDepth: 32, Float: true, Dither: "unknown"},
		{Format: "wav", BitDepth: 32, Float: true, NoiseShaping: "unknown"},
		{Format: "wav", BitDepth: 32, Float: true, Dither: "triangular"},
		{Format: "wav", BitDepth: 64, Float: true, NoiseShaping: "efb"},
		{Format: "wav", BitDepth: 32, Float: true, DocumentID: "stale"},
	} {
		if _, err := e.exportDocument(params); err == nil || len(e.TakeData()) != 0 {
			t.Fatalf("invalid/nonfinite export published bytes: %+v", params)
		}
	}
	if _, err := e.exportDocument(protocol.DocumentExportParams{Format: "wav", BitDepth: 16, Scope: "selection", DocumentID: id}); err != nil {
		t.Fatal("unsafe samples outside integer export selection were included", err)
	}
	e.TakeData()
	if !reflect.DeepEqual(before, e.editResult(false)) {
		t.Fatal("failed or selected export changed editor state")
	}
	for _, selection := range []protocol.SelectionRange{{Start: 2, End: 2, ChannelMask: 1}, {Start: -1, End: 2, ChannelMask: 1}, {End: 5, ChannelMask: 1}, {End: 2, ChannelMask: 2}, {End: 2}} {
		e.editor.selection = selection
		if _, err := e.exportDocument(protocol.DocumentExportParams{Format: "wav", BitDepth: 16, Scope: "selection"}); err == nil {
			t.Fatalf("invalid authoritative selection exported: %+v", selection)
		}
	}
	e.editor.selection = before.Selection.SelectionRange
	if _, err := e.exportDocument(protocol.DocumentExportParams{Format: "wav", BitDepth: 32, Float: true}); err != nil {
		t.Fatal(err)
	}
	defaultData := e.TakeData()
	if _, err := e.exportDocument(protocol.DocumentExportParams{Format: "wav", BitDepth: 32, Float: true, Scope: "document", Dither: "none", NoiseShaping: "none"}); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(defaultData, e.TakeData()) {
		t.Fatal("explicit defaults changed legacy float export")
	}
}

func TestExportSeedUint32ProtocolValidation(t *testing.T) {
	e, id := openEditorFixture(t, []float32{.25, -.25}, 1)
	for _, seed := range []string{"0", "4294967295"} {
		response := call(t, e, protocol.MethodDocumentExport, `{"format":"wav","bitDepth":16,"seed":`+seed+`,"documentId":"`+id+`"}`)
		if !response.OK || len(e.TakeData()) == 0 {
			t.Fatalf("valid uint32 seed %s rejected: %s", seed, response.Error)
		}
	}
	for _, seed := range []string{"-1", "4294967296", "0.5", `"1"`} {
		response := call(t, e, protocol.MethodDocumentExport, `{"format":"wav","bitDepth":16,"seed":`+seed+`}`)
		if response.OK || len(e.TakeData()) != 0 {
			t.Fatalf("invalid uint32 seed %s accepted", seed)
		}
	}
	zero := uint32(0)
	raw, err := json.Marshal(protocol.DocumentExportParams{Format: "wav", BitDepth: 16, Seed: &zero})
	if err != nil || !bytes.Contains(raw, []byte(`"seed":0`)) {
		t.Fatal("explicit deterministic zero seed was omitted", err)
	}
}

// Keep the integer byte oracle independent of the decoder's float32 path.
func exportedIntegerCodes(t *testing.T, data []byte, depth int) []int64 {
	t.Helper()
	pcm := wavDataPayload(t, data)
	codes := make([]int64, len(pcm)/(depth/8))
	for index := range codes {
		offset := index * (depth / 8)
		switch depth {
		case 8:
			codes[index] = int64(pcm[offset]) - 128
		case 16:
			codes[index] = int64(int16(binary.LittleEndian.Uint16(pcm[offset:])))
		case 24:
			value := uint32(pcm[offset]) | uint32(pcm[offset+1])<<8 | uint32(pcm[offset+2])<<16
			codes[index] = int64(int32(value<<8) >> 8)
		case 32:
			codes[index] = int64(int32(binary.LittleEndian.Uint32(pcm[offset:])))
		}
	}
	return codes
}

func TestIntegerExportIgnoresUnsafeUnselectedChannelsAndClearsStaleBinary(t *testing.T) {
	input := []float32{.25, float32(math.Inf(1)), .5, .25, math.Float32frombits(0x7f812345), .5, .25, 0, .5}
	e, id := openEditorFixture(t, input, 3)
	e.editor.selection = protocol.SelectionRange{End: 3, ChannelMask: 5}
	before := e.editResult(false)
	params := protocol.DocumentExportParams{Format: "wav", BitDepth: 16, Scope: "selection", DocumentID: id}
	if response := editorCall(t, e, protocol.MethodDocumentExport, params); !response.OK {
		t.Fatal(response.Error)
	}
	params.Scope = "document"
	if response := editorCall(t, e, protocol.MethodDocumentExport, params); response.OK || len(e.TakeData()) != 0 {
		t.Fatal("included unsafe samples accepted or stale export leaked")
	}
	assertEditBits(t, editSamples(t, e), input)
	if !reflect.DeepEqual(before, e.editResult(false)) {
		t.Fatal("rejected integer export changed source/history")
	}
}

// Independent conventional signed-PCM/TPDF oracle, using only the standard
// library. It checks emitted integers directly and never re-quantizes floats.
func triangularPCMReference(input []float32, depth int, seed uint32, channel int, shaping string) []int64 {
	rng := rand.New(rand.NewPCG(uint64(seed), uint64(channel)+1))
	scale, previousError := math.Exp2(float64(depth-1)), 0.0
	output := make([]int64, len(input))
	for frame, sample := range input {
		shaped := max(-1.0, min(1.0, float64(sample))) * scale
		if shaping == "efb" {
			shaped -= previousError
		}
		noise := rng.Float64() - rng.Float64()
		rounded := math.Round(shaped + noise)
		previousError = rounded - shaped
		output[frame] = int64(max(-scale, min(scale-1, rounded)))
	}
	return output
}

func TestQualityExportIndependentPCMIntegersAndOverloadRecovery(t *testing.T) {
	input := []float32{-1, 1, 0, .25, -.25, .1, -.1, math.MaxFloat32, -math.MaxFloat32, 0, 0, 0, 0, math.Float32frombits(1), math.Float32frombits(0x80000001)}
	e, id := openEditorFixture(t, input, 1)
	seed := uint32(17)
	for _, depth := range []int{8, 16, 24, 32} {
		for _, shaping := range []string{"none", "efb"} {
			params := protocol.DocumentExportParams{Format: "wav", BitDepth: depth, Dither: "triangular", NoiseShaping: shaping, Seed: &seed, DocumentID: id}
			if _, err := e.exportDocument(params); err != nil {
				t.Fatal(err)
			}
			codes := exportedIntegerCodes(t, e.TakeData(), depth)
			if want := triangularPCMReference(input, depth, seed, 0, shaping); !reflect.DeepEqual(codes, want) {
				t.Fatalf("PCM%d/%s integers %v want%v", depth, shaping, codes, want)
			}
		}
	}
	assertEditBits(t, editSamples(t, e), input)
}

func TestQualityExportSeededStateAcrossBlocksAndSourceChannelIdentity(t *testing.T) {
	frames := audiobuf.BlockFrames + 17
	input := make([]float32, frames*3)
	mono := make([]float32, frames)
	for frame := range mono {
		mono[frame] = float32(frame%23-11) / 8192
		for channel := range 3 {
			input[frame*3+channel] = mono[frame]
		}
	}
	e, id := openEditorFixture(t, input, 3)
	seed := uint32(0)
	params := protocol.DocumentExportParams{Format: "wav", BitDepth: 32, Dither: "triangular", NoiseShaping: "efb", Seed: &seed, DocumentID: id}
	if _, err := e.exportDocument(params); err != nil {
		t.Fatal(err)
	}
	firstBytes := e.TakeData()
	first := exportedIntegerCodes(t, firstBytes, 32)
	if _, err := e.exportDocument(params); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(firstBytes, e.TakeData()) {
		t.Fatal("seeded export was not reproducible")
	}
	independent := false
	for channel := range 3 {
		want := triangularPCMReference(mono, 32, seed, channel, "efb")
		for frame, value := range want {
			if first[frame*3+channel] != value {
				t.Fatalf("quantizer state restarted or channel order changed at channel%d/frame%d", channel, frame)
			}
			if channel > 0 && first[frame*3+channel] != first[frame*3] {
				independent = true
			}
		}
	}
	if !independent {
		t.Fatal("seeded noise channels coupled")
	}
	e.editor.selection = protocol.SelectionRange{End: int64(frames), ChannelMask: 4}
	params.Scope = "selection"
	if _, err := e.exportDocument(params); err != nil {
		t.Fatal(err)
	}
	selected := exportedIntegerCodes(t, e.TakeData(), 32)
	for frame, code := range selected {
		if code != first[frame*3+2] {
			t.Fatal("channel subset changed source-channel RNG identity")
		}
	}
	assertEditBits(t, editSamples(t, e), input)
}

func TestQualityExportSilentDitherDCAndEveryPreset(t *testing.T) {
	const frames = 4096
	e, _ := openEditorFixture(t, make([]float32, frames), 1)
	seed := uint32(31)
	for _, kind := range []string{"none", "rectangular", "triangular", "gaussian", "fast-gaussian"} {
		for _, shaping := range []string{"none", "efb", "2sc", "9fc", "sbm", "sharp"} {
			params := protocol.DocumentExportParams{Format: "wav", BitDepth: 16, Dither: kind, NoiseShaping: shaping, Seed: &seed}
			if _, err := e.exportDocument(params); err != nil {
				t.Fatal(err)
			}
			codes := exportedIntegerCodes(t, e.TakeData(), 16)
			sum := int64(0)
			for _, code := range codes {
				sum += code
				if code < -32768 || code > 32767 {
					t.Fatal("noise shaping escaped signed PCM range")
				}
			}
			if mean := float64(sum) / frames; math.Abs(mean) > .1 {
				t.Fatalf("%s/%s silent dither DC=%g LSB", kind, shaping, mean)
			}
		}
	}
}

func TestQualitySelectionExportDuringPreviewUsesCommittedSamples(t *testing.T) {
	input := []float32{.25, .5, -.25, -.5}
	e, id := openEditorFixture(t, input, 1)
	if _, err := e.configure(protocol.EngineConfigureParams{SampleRate: 48000, Channels: 1}); err != nil {
		t.Fatal(err)
	}
	e.editor.selection = protocol.SelectionRange{Start: 1, End: 3, ChannelMask: 1}
	before := e.editResult(false)
	ready := finishEngineProcess(t, e, startEngineProcess(t, e, processParams(e, 0, 4, 1, 6)))
	end := int64(4)
	if _, err := e.playDocument(protocol.TransportPlayParams{End: &end, PreviewJobID: ready.JobID}); err != nil {
		t.Fatal(err)
	}
	seed := uint32(17)
	if _, err := e.exportDocument(protocol.DocumentExportParams{Format: "wav", BitDepth: 32, Scope: "selection", Dither: "triangular", Seed: &seed, DocumentID: id}); err != nil {
		t.Fatal(err)
	}
	if got, want := exportedIntegerCodes(t, e.TakeData(), 32), triangularPCMReference(input[1:3], 32, seed, 0, "none"); !reflect.DeepEqual(got, want) {
		t.Fatal("preview candidate escaped into copy export", got, want)
	}
	if !reflect.DeepEqual(before, e.editResult(false)) || e.transport == nil || e.transport.previewJobID != ready.JobID {
		t.Fatal("quality export changed source/history or stopped preview")
	}
}
