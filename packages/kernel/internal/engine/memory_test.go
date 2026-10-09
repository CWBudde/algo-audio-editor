package engine

import (
	"encoding/json"
	"math"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/audiobuf"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func TestSharedBudgetRejectsImportsAtomically(t *testing.T) {
	for _, format := range []string{"wav", "flac", "aiff", "mp3", "pcm"} {
		t.Run(format, func(t *testing.T) {
			e, _ := openEditorFixture(t, []float32{.25, -.5, .75, 1}, 1)
			before := e.editResult(false)
			input, err := os.ReadFile("testdata/codecs/tone." + map[string]string{"wav": "wav", "flac": "flac", "aiff": "aiff", "mp3": "mp3", "pcm": "wav"}[format])
			if err != nil {
				t.Fatal(err)
			}
			e.memory.limit = e.retainedStorage() + 1
			if format == "pcm" {
				_, err = e.importBinaryDocumentMode(protocol.BinaryDocumentParams{SampleRate: 48000, Channels: 1, Frames: 1}, []byte{0, 0, 0, 0}, true)
			} else {
				_, err = e.openDocument(protocol.DocumentOpenParams{}, input)
			}
			if err == nil || !strings.Contains(err.Error(), "budget") {
				t.Fatalf("import error: %v", err)
			}
			if !reflect.DeepEqual(before, e.editResult(false)) {
				t.Fatal("rejected import changed audio/history")
			}
		})
	}
}

func TestBudgetReservesCandidateUntilCancelOrCommit(t *testing.T) {
	e, _ := openEditorFixture(t, make([]float32, 4096), 1)
	initial := e.retainedStorage()
	// Enough for a candidate, but no whole-file export while it is reserved.
	samples := int64(4096 * 4)
	boundary := decodedStorage(4096, 1, audiobuf.BlockFrames)
	e.memory.limit = initial + samples*2 + boundary + 1
	job := startEngineProcess(t, e, processParams(e, 0, 4096, 1, 6))
	reserved := e.retainedStorage()
	if reserved <= initial || e.jobs.processJob.reservedBytes != samples*2+boundary {
		t.Fatal("candidate was not reserved before stepping")
	}
	if _, err := e.exportDocument(protocol.DocumentExportParams{Format: "wav", BitDepth: 16}); err == nil {
		t.Fatal("export ignored active candidate")
	}
	job = finishEngineProcess(t, e, job)
	if e.retainedStorage() != reserved {
		t.Fatal("ready candidate changed/doubled reservation")
	}
	if _, err := e.cancelProcess(jobParams(job)); err != nil {
		t.Fatal(err)
	}
	if e.retainedStorage() != initial {
		t.Fatal("cancel leaked reservation")
	}
	if _, err := e.exportDocument(protocol.DocumentExportParams{Format: "wav", BitDepth: 16}); err != nil {
		t.Fatal(err)
	}
	e.TakeData()
	job = finishEngineProcess(t, e, startEngineProcess(t, e, processParams(e, 0, 4096, 1, 6)))
	if _, err := e.commitProcess(jobParams(job)); err != nil {
		t.Fatal(err)
	}
	if e.jobs.processJob != nil || e.retainedStorage() > reserved {
		t.Fatal("commit leaked reservation or exceeded budget")
	}
}

func TestBudgetIncludesClipboardAfterDocumentReplacement(t *testing.T) {
	e, _ := openEditorFixture(t, make([]float32, audiobuf.BlockFrames), 1)
	if _, err := e.applyEdit(editParams(e, "copy", 0, e.doc.document.Frames(), 1)); err != nil {
		t.Fatal(err)
	}
	if _, err := e.openDocument(protocol.DocumentOpenParams{}, rawWAV(1, 16, 1, 48000, []byte{0, 0}, false)); err != nil {
		t.Fatal(err)
	}
	stats := audiobuf.CountMemory(e.doc.document)
	if e.retainedStorage() <= stats.SampleBytes+stats.PeakBytes {
		t.Fatal("clipboard retention not counted")
	}
	before := e.editResult(false)
	e.memory.limit = e.retainedStorage() + decodedStorage(1, 1, audiobuf.BlockFrames) + 1
	_, err := e.applyEdit(editParams(e, "paste-mix", 0, 0, 1))
	if err == nil || !strings.Contains(err.Error(), "budget") {
		t.Fatal("paste-mix exceeded shared budget", err)
	}
	if !reflect.DeepEqual(before, e.editResult(false)) {
		t.Fatal("failed paste changed source/clipboard/history")
	}
}

func TestBudgetRejectsConversionAndCodecExportGrowth(t *testing.T) {
	for _, format := range []string{"wav", "flac", "aiff"} {
		t.Run(format, func(t *testing.T) {
			e, _ := openEditorFixture(t, make([]float32, 4096), 1)
			before := e.editResult(false)
			e.memory.limit = e.retainedStorage() + 32
			if _, err := e.exportDocument(protocol.DocumentExportParams{Format: format, BitDepth: 16}); err == nil {
				t.Fatal("export exceeded budget")
			}
			if e.TakeData() != nil || !reflect.DeepEqual(before, e.editResult(false)) {
				t.Fatal("failed export exposed bytes or altered source")
			}
		})
	}
	e, _ := openEditorFixture(t, make([]float32, 4096), 1)
	if _, err := e.applyEdit(editParams(e, "copy", 0, 4096, 1)); err != nil {
		t.Fatal(err)
	}
	if _, err := e.openDocument(protocol.DocumentOpenParams{}, rawWAV(1, 16, 2, 96000, make([]byte, 4096*4), false)); err != nil {
		t.Fatal(err)
	}
	e.memory.limit = e.retainedStorage() + decodedStorage(4096, 2, audiobuf.BlockFrames) + 1
	before := e.editResult(false)
	p := editParams(e, "paste-insert", 0, 0, 3)
	p.Convert = true
	_, err := e.applyEdit(p)
	if err == nil || !strings.Contains(err.Error(), "budget") || !reflect.DeepEqual(before, e.editResult(false)) {
		t.Fatal("conversion did not reject atomically", err)
	}
}

func TestDecodedBudgetAllowsOneHourStereoAndBoundsArithmetic(t *testing.T) {
	e := New()
	const frames = 48000 * 3600
	if err := validateDecodedFormat(48000, 2, 24, frames); err != nil {
		t.Fatal("old 512 MiB ceiling remains", err)
	}
	if err := e.checkDecodedStorage(frames, 2, 4096, 1<<20); err != nil {
		t.Fatal("one-hour compressed stereo rejected", err)
	}
	if err := e.checkDecodedStorage(frames, 2, audiobuf.BlockFrames, frames*2*2); err != nil {
		t.Fatal("one-hour 16-bit WAV rejected", err)
	}
	if err := e.checkDecodedStorage(math.MaxInt64, 8, 1, 0); err == nil {
		t.Fatal("overflowing frame count accepted")
	}
	if e.memory.capacity() != 3<<30 {
		t.Fatal("WASM reserve changed")
	}
	if err := e.checkStorage("probe", -1); err == nil {
		t.Fatal("overflowed request accepted")
	}
}

func TestBudgetAccountsForWriterReallocation(t *testing.T) {
	e := New()
	e.memory.limit = 150
	w := memoryWriteSeeker{budget: e, limit: 150, data: make([]byte, 64), pos: 64}
	if n, err := w.Write([]byte{1}); n != 0 || err == nil || !strings.Contains(err.Error(), "budget") {
		t.Fatal("old allocation ignored during growth", n, err)
	}
	if len(w.data) != 64 || cap(w.data) != 64 || w.pos != 64 {
		t.Fatal("rejected growth changed output")
	}
}

func TestHistoryUsesOwnerCeiling(t *testing.T) {
	e := New()
	e.memory.limit = 2048
	if _, err := e.openDocument(protocol.DocumentOpenParams{}, rawWAV(1, 16, 1, 48000, make([]byte, 256), false)); err != nil {
		t.Fatal(err)
	}
	if e.historyState.history.Limits().MaxBytes != e.memory.capacity() {
		t.Fatal("history uses a separate ceiling")
	}
	before := e.editResult(false)
	if _, err := e.startProcess(processParams(e, 0, e.doc.document.Frames(), 1, 6), nil); err == nil {
		t.Fatal("candidate ignored retained history")
	}
	if !reflect.DeepEqual(before, e.editResult(false)) {
		t.Fatal("rejected candidate altered history")
	}
}

func TestImportBudgetThroughRPC(t *testing.T) {
	e := New()
	e.memory.limit = 1
	var response protocol.Response
	if err := json.Unmarshal(e.CallWithData(protocol.MethodDocumentOpen, []byte(`{"name":"large.wav"}`), rawWAV(1, 16, 1, 48000, make([]byte, 32), false)), &response); err != nil {
		t.Fatal(err)
	}
	if response.OK || !strings.Contains(response.Error, "budget") || e.TakeData() != nil {
		t.Fatalf("RPC response: %+v", response)
	}
}

func TestInputGateRejectsBeforeBridgeAllocation(t *testing.T) {
	e := New()
	e.memory.limit = 1024
	if err := e.CheckInputSize("doc.open", 1024); err != nil {
		t.Fatal(err)
	}
	for _, bytes := range []int64{-1, 1025, math.MaxInt64} {
		if err := e.CheckInputSize("doc.open", bytes); err == nil || !strings.HasPrefix(err.Error(), "doc.open:") {
			t.Fatal("input allocation bypassed budget", bytes, err)
		}
	}
	if e.doc.document.Channels() != 0 || e.bulkData != nil {
		t.Fatal("input gate changed editor")
	}
}
