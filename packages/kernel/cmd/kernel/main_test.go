//go:build js && wasm

package main

import (
	"encoding/binary"
	"encoding/json"
	"math"
	"slices"
	"syscall/js"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/engine"
	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

func TestRenderBridgeValidationIsAtomic(t *testing.T) {
	u8 := js.Global().Get("Uint8Array")
	for _, args := range [][]js.Value{
		nil,
		{u8.New(16)},
		{js.ValueOf("bad"), js.ValueOf(2)},
		{u8.New(16), js.ValueOf("2")},
		{js.Global().Get("Float32Array").New(4), js.ValueOf(2)},
		{u8.New(1), js.ValueOf(2)},
		{u8.New(16), js.ValueOf(0)},
		{u8.New(16), js.ValueOf(-1)},
		{u8.New(16), js.ValueOf(1.5)},
		{u8.New(16), js.ValueOf(math.NaN())},
		{u8.New(16), js.ValueOf(math.Inf(1))},
		{u8.New(16), js.ValueOf(maxRenderFrames + 1)},
		{u8.New(16), js.ValueOf(2), u8.New(15)},
		{u8.New(16), js.ValueOf(2), js.Null()},
		{u8.New(16), js.ValueOf(2), js.Global().Get("Float64Array").New(2)},
	} {
		e, reference := engine.New(), engine.New()
		bridge := &renderBridge{}
		if got := bridge.call(e, args); got != -1 {
			t.Fatalf("invalid render returned %d", got)
		}
		got, want := make([]float32, 8), make([]float32, 8)
		e.Render(got)
		reference.Render(want)
		if !slices.Equal(got, want) || len(bridge.samples) != 0 || len(bridge.positions) != 0 {
			t.Fatal("invalid bridge render advanced audio or allocated buffers")
		}
	}
}

func TestExportBridgeABIAndBinaryOwnership(t *testing.T) {
	api := newKernelAPI(engine.New())
	request := func(method, payload string, data ...js.Value) protocol.Response {
		t.Helper()
		args := []any{method, payload}
		for _, value := range data {
			args = append(args, value)
		}
		var response protocol.Response
		if err := json.Unmarshal([]byte(api.Call("call", args...).String()), &response); err != nil {
			t.Fatal(err)
		}
		return response
	}
	hello := request("hello", "")
	var identity protocol.HelloResult
	if err := json.Unmarshal(hello.Result, &identity); err != nil || !hello.OK || identity.ProtocolVersion != protocol.Version {
		t.Fatalf("bridge ABI identity %+v/%v", identity, err)
	}
	input := make([]byte, 52)
	copy(input[:4], "RIFF")
	binary.LittleEndian.PutUint32(input[4:], 44)
	copy(input[8:16], "WAVEfmt ")
	binary.LittleEndian.PutUint32(input[16:], 16)
	binary.LittleEndian.PutUint16(input[20:], 3)
	binary.LittleEndian.PutUint16(input[22:], 1)
	binary.LittleEndian.PutUint32(input[24:], 48000)
	binary.LittleEndian.PutUint32(input[28:], 192000)
	binary.LittleEndian.PutUint16(input[32:], 4)
	binary.LittleEndian.PutUint16(input[34:], 32)
	copy(input[36:40], "data")
	binary.LittleEndian.PutUint32(input[40:], 8)
	binary.LittleEndian.PutUint32(input[44:], math.Float32bits(-1))
	binary.LittleEndian.PutUint32(input[48:], math.Float32bits(1))
	u8 := js.Global().Get("Uint8Array")
	inputJS := u8.New(len(input))
	js.CopyBytesToJS(inputJS, input)
	if response := request("doc.open", `{"name":"bridge.wav"}`, inputJS); !response.OK {
		t.Fatal(response.Error)
	}
	inputJS.Call("fill", 0)
	for range 2 {
		response := request("doc.export", `{"format":"wav","bitDepth":32,"noiseShaping":"efb","seed":4294967295}`)
		if !response.OK {
			t.Fatal(response.Error)
		}
		var exported protocol.DocumentExportInfo
		if err := json.Unmarshal(response.Result, &exported); err != nil {
			t.Fatal(err)
		}
		binaryJS := api.Call("takeData")
		if !binaryJS.InstanceOf(u8) || binaryJS.Get("byteLength").Int() != exported.DataBytes {
			t.Fatal("WAV binary did not cross as Uint8Array")
		}
		bytes := make([]byte, exported.DataBytes)
		js.CopyBytesToGo(bytes, binaryJS)
		if binary.LittleEndian.Uint32(bytes[44:]) != 0x80000000 || binary.LittleEndian.Uint32(bytes[48:]) != 0x7fffffff {
			t.Fatal("signed PCM32 endpoint bits changed at public boundary")
		}
		binaryJS.Call("fill", 0)
		if api.Call("takeData").Get("byteLength").Int() != 0 {
			t.Fatal("export binary was available twice")
		}
	}
	// EFB's half-LSB feedback creates an odd large PCM32 code that cannot
	// survive a normalized float32 roundtrip. Exercise the direct integer path.
	binary.LittleEndian.PutUint32(input[44:], math.Float32bits(float32(-21.5/math.Exp2(31))))
	binary.LittleEndian.PutUint32(input[48:], math.Float32bits(.25))
	js.CopyBytesToJS(inputJS, input)
	if response := request("doc.open", `{"name":"precise.wav"}`, inputJS); !response.OK {
		t.Fatal(response.Error)
	}
	if response := request("doc.export", `{"format":"wav","bitDepth":32,"noiseShaping":"efb","seed":0}`); !response.OK {
		t.Fatal(response.Error)
	}
	exactJS := api.Call("takeData")
	exact := make([]byte, exactJS.Get("byteLength").Int())
	js.CopyBytesToGo(exact, exactJS)
	if binary.LittleEndian.Uint32(exact[44:]) != 0xffffffea || binary.LittleEndian.Uint32(exact[48:]) != 0x20000001 {
		t.Fatal("PCM32 lost low bits through float32 re-quantization")
	}
	if response := request("doc.export", `{"format":"wav","bitDepth":16}`); !response.OK {
		t.Fatal(response.Error)
	}
	if response := request("doc.export", `{"format":"wav","bitDepth":16,"seed":4294967296}`); response.OK || api.Call("takeData").Get("byteLength").Int() != 0 {
		t.Fatal("invalid uint32 seed left stale binary output")
	}
	if response := request("doc.export", `{"format":"wav","bitDepth":16}`); !response.OK {
		t.Fatal(response.Error)
	}
	invalid := api.Call("call", 7).String()
	var response protocol.Response
	if json.Unmarshal([]byte(invalid), &response) != nil || response.OK || api.Call("takeData").Get("byteLength").Int() != 0 {
		t.Fatal("invalid bridge arguments retained stale export bytes")
	}
}

func TestRenderBridgeCopiesSamplesAndInt64Positions(t *testing.T) {
	input := make([]byte, 48)
	copy(input[:4], "RIFF")
	binary.LittleEndian.PutUint32(input[4:8], 40)
	copy(input[8:16], "WAVEfmt ")
	binary.LittleEndian.PutUint32(input[16:20], 16)
	binary.LittleEndian.PutUint16(input[20:22], 1)
	binary.LittleEndian.PutUint16(input[22:24], 1)
	binary.LittleEndian.PutUint32(input[24:28], 48000)
	binary.LittleEndian.PutUint32(input[28:32], 96000)
	binary.LittleEndian.PutUint16(input[32:34], 2)
	binary.LittleEndian.PutUint16(input[34:36], 16)
	copy(input[36:40], "data")
	binary.LittleEndian.PutUint32(input[40:44], 4)
	binary.LittleEndian.PutUint16(input[44:46], 8192)
	binary.LittleEndian.PutUint16(input[46:48], 49152) // -16384
	e := engine.New()
	e.CallWithData("doc.open", []byte(`{"name":"bridge.wav"}`), input)
	e.Call("engine.configure", []byte(`{"sampleRate":48000,"channels":1}`))
	e.Call("transport.play", []byte(`{"start":0,"loop":false}`))
	dst, positions := js.Global().Get("Uint8Array").New(16), js.Global().Get("Uint8Array").New(32)
	bridge := &renderBridge{}
	if written := bridge.call(e, []js.Value{dst, js.ValueOf(4), positions}); written != 2 {
		t.Fatalf("bridge wrote %d frames, want 2", written)
	}
	samples, tags := make([]byte, 16), make([]byte, 32)
	js.CopyBytesToGo(samples, dst)
	js.CopyBytesToGo(tags, positions)
	for i, want := range []float32{0.25, -0.5, 0, 0} {
		if got := math.Float32frombits(binary.LittleEndian.Uint32(samples[i*4:])); got != want {
			t.Fatalf("sample %d=%v, want %v", i, got, want)
		}
	}
	for i, want := range []int64{1, 2, 0, 0} {
		if got := int64(binary.LittleEndian.Uint64(tags[i*8:])); got != want {
			t.Fatalf("tag %d=%d, want %d", i, got, want)
		}
	}
	// Smaller steady-state requests reuse all sample/tag storage.
	if written := bridge.call(e, []js.Value{dst, js.ValueOf(2), positions}); written != 0 || cap(bridge.samples) != 4 || cap(bridge.positions) != 4 {
		t.Fatal("EOF render changed reused buffers")
	}
}
