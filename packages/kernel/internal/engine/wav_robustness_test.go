package engine

import (
	"encoding/binary"
	"math"
	"slices"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

// rf64Fixture builds ds64 independently of the normalized decoder adapter.
func rf64Fixture(base []byte, frames uint64, table []byte) []byte {
	body := make([]byte, 28+len(table))
	binary.LittleEndian.PutUint64(body[8:], uint64(len(base)-44))
	binary.LittleEndian.PutUint64(body[16:], frames)
	binary.LittleEndian.PutUint32(body[24:], uint32(len(table)/12))
	copy(body[28:], table)
	chunk := timelineRIFFChunk("ds64", body)
	result := append(slices.Clone(base[:12]), chunk...)
	result = append(result, base[12:]...)
	copy(result, "RF64")
	binary.LittleEndian.PutUint32(result[4:], math.MaxUint32)
	binary.LittleEndian.PutUint64(result[20:], uint64(len(result)-8))
	binary.LittleEndian.PutUint32(result[40+len(chunk):], math.MaxUint32)
	return result
}

func TestWAVRecoverUnfinalizedRecordings(t *testing.T) {
	base := rawWAV(1, 16, 1, 48000, intPayload(16, []int32{8192, -16384, 4096}), false)
	for _, tc := range []struct {
		name   string
		mutate func([]byte) []byte
		want   []float32
	}{
		{"oversized RIFF", func(b []byte) []byte { binary.LittleEndian.PutUint32(b[4:], uint32(len(b)+1024)); return b }, []float32{.25, -.5, .125}},
		{"zero RIFF", func(b []byte) []byte { clear(b[4:8]); return b }, []float32{.25, -.5, .125}},
		{"sentinel RIFF", func(b []byte) []byte { binary.LittleEndian.PutUint32(b[4:], math.MaxUint32); return b }, []float32{.25, -.5, .125}},
		{"zero data", func(b []byte) []byte { clear(b[40:44]); return b }, []float32{.25, -.5, .125}},
		{"sentinel data", func(b []byte) []byte { binary.LittleEndian.PutUint32(b[40:], math.MaxUint32); return b }, []float32{.25, -.5, .125}},
		{"partial last frame", func(b []byte) []byte { return b[:len(b)-1] }, []float32{.25, -.5}},
		{"RF64", func(b []byte) []byte { return rf64Fixture(b, 3, nil) }, []float32{.25, -.5, .125}},
		{"truncated RF64", func(b []byte) []byte { r := rf64Fixture(b, 3, nil); return r[:len(r)-1] }, []float32{.25, -.5}},
		{"overflowing ds64 sizes", func(b []byte) []byte {
			r := rf64Fixture(b, 3, nil)
			binary.LittleEndian.PutUint64(r[20:], math.MaxUint64)
			binary.LittleEndian.PutUint64(r[28:], math.MaxUint64)
			return r
		}, []float32{.25, -.5, .125}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := New()
			info, err := e.openDocument(protocol.DocumentOpenParams{}, tc.mutate(slices.Clone(base)))
			if err != nil || info.Format != "wav" || info.Frames != int64(len(tc.want)) {
				t.Fatalf("open = %+v, %v", info, err)
			}
			assertDocumentSamples(t, e, tc.want, 1)
			if _, err := e.exportDocument(protocol.DocumentExportParams{Format: "wav", BitDepth: 16}); err != nil {
				t.Fatal(err)
			}
			if _, err := inspectWAV(e.TakeData()); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestWAVMissingFinalPadding(t *testing.T) {
	for _, id := range []string{"data", "xtra"} {
		t.Run(id, func(t *testing.T) {
			base := rawWAV(1, 8, 1, 48000, []byte{0, 128, 255}, false)
			if id != "data" {
				base = wavWithTimeline(base, false, timelineRIFFChunk(id, []byte{1, 2, 3}))
			}
			base = base[:len(base)-1]
			binary.LittleEndian.PutUint32(base[4:], uint32(len(base)-8))
			if _, err := New().openDocument(protocol.DocumentOpenParams{}, base); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestRF64SizeTableAndMalformedMetadata(t *testing.T) {
	base := rawWAV(1, 16, 1, 48000, intPayload(16, []int32{8192}), false)
	table := make([]byte, 12)
	copy(table, "xtra")
	binary.LittleEndian.PutUint64(table[4:], 3)
	valid := rf64Fixture(base, 1, table)
	chunk := timelineRIFFChunk("xtra", []byte{1, 2, 3})
	binary.LittleEndian.PutUint32(chunk[4:], math.MaxUint32)
	valid = append(valid, chunk...)
	binary.LittleEndian.PutUint64(valid[20:], uint64(len(valid)-8))
	if _, err := New().openDocument(protocol.DocumentOpenParams{}, valid); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name  string
		input []byte
	}{
		{"absent ds64", append([]byte("RF64"), base[4:]...)},
		{"short ds64", valid[:47]},
		{"truncated metadata", valid[:len(valid)-2]},
		{"missing size-table entry", func() []byte { b := slices.Clone(valid); copy(b[len(b)-12:], "xxxx"); return b }()},
		{"oversized size table", func() []byte {
			b := slices.Clone(valid)
			binary.LittleEndian.PutUint32(b[44:], math.MaxUint32)
			return b
		}()},
		{"truncated fmt", func() []byte {
			b := slices.Clone(base)
			binary.LittleEndian.PutUint32(b[16:], math.MaxUint32)
			return b
		}()},
		{"unaligned finalized data", rawWAV(1, 16, 2, 48000, []byte{1, 2}, false)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := New()
			if _, err := e.openDocument(protocol.DocumentOpenParams{}, tc.input); err == nil {
				t.Fatal("malformed metadata accepted")
			}
			if e.doc.document.Channels() != 0 {
				t.Fatal("failed open installed audio")
			}
		})
	}
}
