package engine

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func minimalPCM16WAV() []byte {
	data := make([]byte, 52)
	copy(data, "RIFF")
	binary.LittleEndian.PutUint32(data[4:], uint32(len(data)-8))
	copy(data[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(data[16:], 16)
	binary.LittleEndian.PutUint16(data[20:], 1)
	binary.LittleEndian.PutUint16(data[22:], 1)
	binary.LittleEndian.PutUint32(data[24:], 48000)
	binary.LittleEndian.PutUint32(data[28:], 96000)
	binary.LittleEndian.PutUint16(data[32:], 2)
	binary.LittleEndian.PutUint16(data[34:], 16)
	copy(data[36:], "data")
	binary.LittleEndian.PutUint32(data[40:], 8)
	for i, sample := range []uint16{0, 32768, 32767, 16384} {
		binary.LittleEndian.PutUint16(data[44+i*2:], sample)
	}

	return data
}

func wavDataPayload(t *testing.T, data []byte) []byte {
	t.Helper()
	for offset := 12; offset+8 <= len(data); {
		size := int(binary.LittleEndian.Uint32(data[offset+4:]))
		if size > len(data)-offset-8 {
			t.Fatal("truncated exported WAV chunk")
		}
		if string(data[offset:offset+4]) == "data" {
			return data[offset+8 : offset+8+size]
		}
		offset += 8 + size + size%2
	}
	t.Fatal("exported WAV has no data chunk")

	return nil
}

func TestDocumentRPCBinaryRoundTrip(t *testing.T) {
	e := New()
	source := minimalPCM16WAV()
	wantPayload := bytes.Clone(source[44:])
	var opened protocol.Response
	if err := json.Unmarshal(e.CallWithData(protocol.MethodDocumentOpen, []byte(`{"name":"source.wav"}`), source), &opened); err != nil {
		t.Fatal(err)
	}
	if !opened.OK {
		t.Fatalf("doc.open: %s", opened.Error)
	}
	clear(source) // Imported blocks cannot retain or alias the encoded input.
	info := call(t, e, protocol.MethodDocumentInfo, "")
	if !info.OK || !bytes.Equal(info.Result, opened.Result) {
		t.Fatalf("doc.info differs from imported format: %s, %s", info.Result, opened.Result)
	}
	var format protocol.DocumentInfoResult
	if err := json.Unmarshal(info.Result, &format); err != nil {
		t.Fatal(err)
	}
	if format.Name != "source.wav" || format.Frames != 4 || format.Channels != 1 || format.SampleRate != 48000 || format.BitDepth != 16 || format.Float {
		t.Fatalf("unexpected document format: %+v", format)
	}
	peaks := call(t, e, protocol.MethodPeaksGet, `{"channel":0,"startFrame":0,"endFrame":4,"buckets":4}`)
	if !peaks.OK || len(e.TakeData()) != 4*24 {
		t.Fatalf("peaks for imported WAV: %s", peaks.Error)
	}
	for range 2 {
		exported := call(t, e, protocol.MethodDocumentExport, `{"format":"wav","bitDepth":16,"float":false}`)
		if !exported.OK {
			t.Fatalf("doc.export: %s", exported.Error)
		}
		var metadata protocol.DocumentExportInfo
		if err := json.Unmarshal(exported.Result, &metadata); err != nil {
			t.Fatal(err)
		}
		data := e.TakeData()
		if metadata.DataBytes != len(data) || metadata.MimeType != "audio/wav" || metadata.Name != "source.wav" {
			t.Fatalf("export metadata = %+v, binary size %d", metadata, len(data))
		}
		if !bytes.Equal(wavDataPayload(t, data), wantPayload) {
			t.Fatal("16-bit payload changed during import/export")
		}
		clear(data) // Exported bytes are caller-owned; document storage is immutable.
		if len(e.TakeData()) != 0 {
			t.Fatal("export returned the same binary result twice")
		}
	}
	// Audio passed as JSON must never be accepted as a substitute for binary input.
	bad := call(t, e, protocol.MethodDocumentOpen, `{"name":"bad.wav","bytes":[82,73,70,70]}`)
	if bad.OK {
		t.Fatal("doc.open accepted encoded bytes through JSON")
	}
	unchanged := call(t, e, protocol.MethodDocumentInfo, "")
	if !unchanged.OK || !bytes.Equal(unchanged.Result, info.Result) {
		t.Fatal("rejected binary import changed the active document")
	}
}
