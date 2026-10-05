package engine

import (
	"encoding/binary"
	"encoding/json"
	"math"
	"reflect"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

// FuzzDocumentExport exercises the actual encoders, metadata and quantization
// paths. Direct calls deliberately expose unexpected panics to the fuzzer;
// production RPCs additionally have CallWithData's recovery boundary.
func FuzzDocumentExport(f *testing.F) {
	for _, format := range []string{"wav", "flac", "aiff"} {
		f.Add([]byte{0, 0, 0, 0, 0, 0, 128, 63}, []byte(`{"format":"`+format+`","bitDepth":16,"scope":"document"}`))
	}
	f.Add([]byte{1, 0, 192, 127, 0, 0, 0, 128}, []byte(`{"format":"wav","bitDepth":32,"float":true}`))
	f.Add([]byte{0, 0, 0, 0}, []byte(`{"format":"wav","bitDepth":8,"dither":"triangular","seed":1}`))
	f.Fuzz(func(t *testing.T, samples, params []byte) {
		if len(samples) > 4096 || len(params) > 4096 {
			return
		}
		var p protocol.DocumentExportParams
		if json.Unmarshal(params, &p) != nil {
			return
		}
		e := New()
		e.memory.limit = 32 << 20
		samples = samples[:len(samples)/4*4]
		if _, err := e.openDocument(protocol.DocumentOpenParams{}, rawWAV(3, 32, 1, 48000, samples, false)); err != nil {
			t.Fatal(err)
		}
		e.doc.editor.selection = protocol.SelectionRange{End: e.doc.document.Frames(), ChannelMask: 1}
		before := e.editResult(false)
		info, err := e.exportDocument(p)
		if !reflect.DeepEqual(before, e.editResult(false)) {
			t.Fatal("export changed source, selection or history")
		}
		if err != nil {
			return
		}
		data := e.TakeData()
		if info.DataBytes != len(data) {
			t.Fatal("export length does not match bytes")
		}
		reopened := New()
		reopened.memory.limit = 32 << 20
		opened, err := reopened.openDocument(protocol.DocumentOpenParams{}, data)
		if err != nil {
			t.Fatalf("encoder produced unreadable %s: %v", p.Format, err)
		}
		if opened.Frames != e.doc.document.Frames() || opened.Channels != 1 || opened.SampleRate != 48000 {
			t.Fatal("export changed format")
		}
		if p.Format == "wav" && p.Float && p.BitDepth == 32 {
			layout, err := inspectWAV(data)
			if err != nil {
				t.Fatal(err)
			}
			original := make([]float32, e.doc.document.Frames())
			channel, _ := e.doc.document.Channel(0)
			channel.Read(original, 0)
			for i, value := range original {
				bits := math.Float32bits(value)
				// NaN payload/signaling conversion is codec-specific. Finite
				// samples, subnormals and signed zero must remain bit exact.
				if bits&0x7f800000 != 0x7f800000 && bits != binary.LittleEndian.Uint32(data[layout.dataStart+i*4:]) {
					t.Fatal("float32 export changed finite sample bits")
				}
			}
		}
	})
}
