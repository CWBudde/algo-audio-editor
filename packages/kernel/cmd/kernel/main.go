//go:build js && wasm

// Command kernel is the WebAssembly entry point. It exposes the engine to
// JavaScript as globalThis.AAEKernel and then blocks forever, keeping the Go
// runtime alive for callbacks.
//
// The surface is deliberately tiny:
//
//	AAEKernel.call(method: string, paramsJSON?: string, data?: Uint8Array): string // protocol.Response JSON
//	AAEKernel.takeData(): Uint8Array                           // preceding call's bulk result
//	AAEKernel.render(dst: Uint8Array, frames: number, positions?: Uint8Array): number
//
// Everything else is a protocol method behind call(), so adding features never
// changes the control protocol; bulk results use takeData().
package main

import (
	"encoding/binary"
	"math"
	"runtime/debug"
	"syscall/js"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/engine"
)

const bytesPerFloat32 = 4

// Render-ahead requests are deliberately bounded independently of ring size.
// Eight-channel sample/tag buffers stay below 7 MiB at this maximum.
const maxRenderFrames = 65536

// Keep byte lengths representable on wasm32. Phase 10 adds paged storage and
// streaming file input instead of copying a whole multi-gigabyte source.
const maxBinaryInputBytes = math.MaxInt32

// renderBridge carries a block of audio from Go to JS with a single
// js.CopyBytesToJS per call. Writing a Float32Array element by element would
// cost one syscall/js crossing per sample; see algo-dsp/web/wasm/main.go for
// the measurements behind this pattern. The Go-side buffers are reused, so the
// steady state allocates nothing.
type renderBridge struct {
	samples     []float32
	raw         []byte
	positions   []int64
	positionRaw []byte
}

func (b *renderBridge) render(eng *engine.Engine, dst, positionDst js.Value, frames int) int {
	n := frames * eng.Channels()
	if cap(b.samples) < n {
		b.samples = make([]float32, n)
		b.raw = make([]byte, n*bytesPerFloat32)
	}

	samples := b.samples[:n]
	raw := b.raw[:n*bytesPerFloat32]

	var positions []int64
	if positionDst.Type() != js.TypeUndefined {
		if cap(b.positions) < frames {
			b.positions = make([]int64, frames)
			b.positionRaw = make([]byte, frames*8)
		}
		positions = b.positions[:frames]
	}
	written := eng.RenderWithPositions(samples, positions)

	// WASM is little-endian, as is a Float32Array over the same bytes.
	for i, v := range samples {
		binary.LittleEndian.PutUint32(raw[i*bytesPerFloat32:], math.Float32bits(v))
	}

	js.CopyBytesToJS(dst, raw)
	if positions != nil {
		positionRaw := b.positionRaw[:frames*8]
		for i, position := range positions {
			binary.LittleEndian.PutUint64(positionRaw[i*8:], uint64(position))
		}
		js.CopyBytesToJS(positionDst, positionRaw)
	}

	return written
}

func (b *renderBridge) call(eng *engine.Engine, args []js.Value) int {
	if len(args) < 2 || args[0].Type() != js.TypeObject || args[1].Type() != js.TypeNumber {
		return -1
	}
	dst, count := args[0], args[1].Float()
	if !dst.InstanceOf(js.Global().Get("Uint8Array")) || math.IsNaN(count) || math.IsInf(count, 0) || count != math.Trunc(count) || count <= 0 || count > maxRenderFrames {
		return -1
	}
	frames := int(count)
	if dst.Get("byteLength").Int() < frames*eng.Channels()*bytesPerFloat32 {
		return -1
	}
	positionDst := js.Undefined()
	if len(args) > 2 && args[2].Type() != js.TypeUndefined {
		positionDst = args[2]
		if positionDst.Type() != js.TypeObject || !positionDst.InstanceOf(js.Global().Get("Uint8Array")) || positionDst.Get("byteLength").Int() < frames*8 {
			return -1
		}
	}
	return b.render(eng, dst, positionDst, frames)
}

func newKernelAPI(eng *engine.Engine) js.Value {
	bridge := &renderBridge{}

	api := js.Global().Get("Object").New()

	api.Set("call", js.FuncOf(func(_ js.Value, args []js.Value) any {
		// Invalid bridge arguments also invalidate the preceding binary result.
		eng.TakeData()
		if len(args) < 1 || args[0].Type() != js.TypeString {
			return `{"ok":false,"error":"call: method must be a string"}`
		}

		var payload []byte
		if len(args) > 1 && args[1].Type() == js.TypeString {
			payload = []byte(args[1].String())
		}

		var input []byte
		if len(args) > 2 && args[2].Type() != js.TypeUndefined {
			if args[2].Type() != js.TypeObject || !args[2].InstanceOf(js.Global().Get("Uint8Array")) {
				return `{"ok":false,"error":"call: binary data must be a Uint8Array"}`
			}
			n := args[2].Get("byteLength").Float()
			if n > maxBinaryInputBytes {
				return `{"ok":false,"error":"call: file exceeds the 2 GiB whole-file import limit"}`
			}
			input = make([]byte, int(n))
			js.CopyBytesToGo(input, args[2])
		}

		return string(eng.CallWithData(args[0].String(), payload, input))
	}))

	api.Set("takeData", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		data := eng.TakeData()
		dst := js.Global().Get("Uint8Array").New(len(data))
		js.CopyBytesToJS(dst, data)

		return dst
	}))

	api.Set("render", js.FuncOf(func(_ js.Value, args []js.Value) any {
		return bridge.call(eng, args)
	}))
	return api
}

func main() {
	// Fewer, larger collections: GC pauses stall the worker that feeds the
	// playback ring buffer, and the heap here is dominated by long-lived audio.
	debug.SetGCPercent(300)

	api := newKernelAPI(engine.New())

	js.Global().Set("AAEKernel", api)

	// Tell the loader the API is in place. go.run() resolves only when the Go
	// program exits, so it cannot be used as a readiness signal.
	if ready := js.Global().Get("__aaeKernelReady"); ready.Type() == js.TypeFunction {
		ready.Invoke()
	}

	select {}
}
