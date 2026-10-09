# Speech generation design

Status: approved 2026-10-09. Guide: [docs/speech.md](../../speech.md).

## Goal

**Process → Generate speech…** turns text into speech with
[go-pocket-tts](https://github.com/cwbudde/go-pocket-tts) (Kyutai PocketTTS,
pure Go) and places it like the existing generators (sine, noise): insert at
the cursor, or replace the selection on the selected channels, as a
cancellable job with Preview/Apply and one undo entry. It works in the
browser, in Electron, and natively through `aae` and `aae-mcp`.

## Decisions

| Topic | Decision |
| --- | --- |
| Runtime | Separate lazily loaded `speech.wasm` in its own Web Worker. `kernel.wasm` sits at its 12 MiB budget and every cold start would pay for TTS otherwise. |
| Kernel boundary | `process.start` with `operation: "generate"`, `generator: "audio"`, `sourceSampleRate`, and the mono float32 PCM as the binary argument. The kernel resamples it to the document rate and reuses the generators' placement, timeline splice, preview and undo. `internal/engine` stays free of TTS. |
| Length | Speech keeps its natural length. With a selection, the selection is replaced by the speech, not stretched to it. |
| Channels | The mono speech is written to every selected channel; unselected channels get silence on insert, as with generators. On a selection of only some channels the region grows to max(speech, selection): selected channels get the speech plus silence, the others keep their audio plus silence, so the channels stay in sync. |
| Upstream | go-pocket-tts gains a public package (module root): catalog with pinned URLs, SHA-256, sizes and model-root paths; `Load`/`LoadDir`; `Synthesize` with seed, progress, cancellation and sentence chunking; `download.Model`. MIT license added. |
| Models | All six catalog configs (English and German, 6 and 24 layers). |
| Web models | Fetched by the speech worker from the pinned Hugging Face URLs, cached by the browser HTTP cache, as in the go-pocket-tts web demo; SHA-256 checked before loading. |
| Electron models | Downloaded by the main process into `userData/speech-models` (catalog layout), allowed hosts `huggingface.co` and `*.hf.co`, temp file → SHA-256 → atomic rename, cancellable, removable. Served as `app://editor/speech-models/…`, so the renderer CSP stays `connect-src 'self'`. |
| Native models | `--speech-models <dir>` in the catalog layout; `aae speech download` fills it. |
| Determinism | Same seed, build, platform and worker count → identical samples. Native (assembly kernels) and WASM (pure Go) differ, so speech is the documented exception to byte-identical UI/CLI parity; the parity test compares length and a sample tolerance. `aae` keeps one worker. |
| Chains | `speech.generate {model, voice, text, temperature, samplerSteps, eosThreshold, seed}`; replay synthesizes again from these fields. Generate records the seed it used. |
| Licensing | Dialog credits "Kyutai PocketTTS · weights CC-BY-4.0". Weights are never bundled. |

## Errors and cancellation

Download failures and checksum mismatches show inline with Retry; a corrupt
file is never loaded. Cancel aborts the fetch, the Electron download, the
synthesis (checked every frame; the worker yields to its event loop every
few frames so the cancel message arrives) or the kernel job. A Go exit in the
speech worker (out of memory) reports `stopped`; the next Generate starts a
fresh worker and the message suggests a 6-layer model. Text is required and
limited to 5,000 characters; another active process job blocks Generate.

## Testing

Kernel table tests for the `audio` generator (insert, replace with another
length, channel masks, timeline splice, resampling, invalid PCM, memory
reservation, undo). Speech adapter tests with a fake engine and opt-in real
model tests (`AAE_SPEECH_MODELS`). Vitest for the dialog and model sources,
Node tests for the Electron download policy, Playwright with a stub speech
worker, and a Pages test that a worker fetch through the isolation service
worker reaches a routed fake Hugging Face origin.
