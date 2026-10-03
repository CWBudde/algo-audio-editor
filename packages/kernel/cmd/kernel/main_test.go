//go:build js && wasm

package main

import (
	"encoding/binary"
	"math"
	"slices"
	"syscall/js"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/engine"
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
