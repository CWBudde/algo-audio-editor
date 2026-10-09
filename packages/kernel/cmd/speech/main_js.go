//go:build js && wasm

// The surface the speech worker uses:
//
//	AAESpeech.sampleRate: number                                   // 24000
//	AAESpeech.catalog(): string                                    // model catalog JSON
//	AAESpeech.load(model, weights: Uint8Array, tokenizer: Uint8Array): Promise<void>
//	AAESpeech.loadVoice(model, voice, data: Uint8Array): Promise<void>
//	AAESpeech.synthesize(paramsJSON, onProgress?): Promise<Uint8Array> // LE float32 PCM
//	AAESpeech.cancel(): void
//	AAESpeech.unload(): Promise<void>
//	AAESpeech.loaded(): string                                     // {"model","voices"}
//
// onProgress(chunk, chunks, step, maxSteps) runs after every frame.
package main

import (
	"encoding/json"
	"errors"
	"runtime/debug"
	"syscall/js"
	"time"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/speech"
	pockettts "github.com/cwbudde/go-pocket-tts"
)

// heapLimit keeps the Go heap below 32-bit WASM's 4 GiB: near it the GC
// collects instead of doubling the heap of a large model's weights.
const heapLimit = 3584 << 20

// promise runs work off the event loop and settles a JS Promise with its
// result; errors reject with an Error carrying the message.
func promise(work func() (any, error)) js.Value {
	executor := js.FuncOf(func(_ js.Value, args []js.Value) any {
		resolve, reject := args[0], args[1]
		go func() {
			value, err := work()
			if err != nil {
				reject.Invoke(js.Global().Get("Error").New(err.Error()))
				return
			}
			resolve.Invoke(value)
		}()
		return nil
	})
	// The executor runs synchronously inside the constructor.
	defer executor.Release()
	return js.Global().Get("Promise").New(executor)
}

func bytesArg(args []js.Value, i int) ([]byte, error) {
	if len(args) <= i || !args[i].InstanceOf(js.Global().Get("Uint8Array")) {
		return nil, errors.New("speech: expected a Uint8Array argument")
	}
	data := make([]byte, args[i].Get("length").Int())
	js.CopyBytesToGo(data, args[i])
	return data, nil
}

func stringArg(args []js.Value, i int) (string, error) {
	if len(args) <= i || args[i].Type() != js.TypeString {
		return "", errors.New("speech: expected a string argument")
	}
	return args[i].String(), nil
}

func newSpeechAPI(b *bridge) js.Value {
	api := js.Global().Get("Object").New()
	api.Set("sampleRate", speech.SampleRate)
	api.Set("catalog", js.FuncOf(func(js.Value, []js.Value) any {
		return string(pockettts.CatalogJSON())
	}))
	api.Set("load", js.FuncOf(func(_ js.Value, args []js.Value) any {
		model, err := stringArg(args, 0)
		weights, err1 := bytesArg(args, 1)
		tokenizer, err2 := bytesArg(args, 2)
		return promise(func() (any, error) {
			if err := errors.Join(err, err1, err2); err != nil {
				return nil, err
			}
			return js.Undefined(), b.load(model, weights, tokenizer)
		})
	}))
	api.Set("loadVoice", js.FuncOf(func(_ js.Value, args []js.Value) any {
		model, err := stringArg(args, 0)
		voice, err1 := stringArg(args, 1)
		data, err2 := bytesArg(args, 2)
		return promise(func() (any, error) {
			if err := errors.Join(err, err1, err2); err != nil {
				return nil, err
			}
			return js.Undefined(), b.loadVoice(model, voice, data)
		})
	}))
	api.Set("synthesize", js.FuncOf(func(_ js.Value, args []js.Value) any {
		params, err := stringArg(args, 0)
		onProgress := js.Undefined()
		if len(args) > 1 && args[1].Type() == js.TypeFunction {
			onProgress = args[1]
		}
		return promise(func() (any, error) {
			if err != nil {
				return nil, err
			}
			pcm, err := b.synthesize([]byte(params), func(p pockettts.Progress) {
				if onProgress.Type() == js.TypeFunction {
					onProgress.Invoke(p.Chunk, p.Chunks, p.Step, p.MaxSteps)
				}
				// Hand the event loop a turn so a cancel message can run.
				time.Sleep(time.Millisecond)
			})
			if err != nil {
				return nil, err
			}
			out := js.Global().Get("Uint8Array").New(len(pcm))
			js.CopyBytesToJS(out, pcm)
			return out, nil
		})
	}))
	api.Set("cancel", js.FuncOf(func(js.Value, []js.Value) any {
		b.stop()
		return nil
	}))
	api.Set("unload", js.FuncOf(func(js.Value, []js.Value) any {
		return promise(func() (any, error) { return js.Undefined(), b.unload() })
	}))
	api.Set("loaded", js.FuncOf(func(js.Value, []js.Value) any {
		model, voices := b.loaded()
		data, _ := json.Marshal(map[string]any{"model": model, "voices": voices})
		return string(data)
	}))
	return api
}

func main() {
	debug.SetMemoryLimit(heapLimit)
	js.Global().Set("AAESpeech", newSpeechAPI(new(bridge)))
	// go.run() resolves only when the program exits, so the loader waits
	// for this call instead.
	if ready := js.Global().Get("__aaeSpeechReady"); ready.Type() == js.TypeFunction {
		ready.Invoke()
	}
	select {}
}
