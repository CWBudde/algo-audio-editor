# Speech generation

**Process → Generate speech…** speaks text with
[go-pocket-tts](https://github.com/cwbudde/go-pocket-tts), a pure-Go port of
[Kyutai PocketTTS](https://huggingface.co/kyutai/pocket-tts), and places the
result like the other generators: at a cursor it is inserted, a selection is
replaced. It is one undoable edit with Preview and Apply. Native automation
uses the same models; see [Speech in the MCP guide](mcp.md#speech).

## Using the dialog

1. Choose a **model** (English or German, 6 or 24 layers) and a **voice**.
2. Type up to 5,000 characters. Long text is synthesized sentence by sentence;
   the progress shows the current sentence.
3. **Generate** downloads the model the first time, synthesizes and prepares
   the edit. **Preview** plays it in place; **Apply** commits it.

The placement line under the text says what Apply does: insert at the cursor,
replace the selection, or fill an empty document. The speech keeps its own
length. A selection is replaced by it, not stretched to it. On a selection of
only some channels the region grows to fit the speech, and the other channels
keep their audio followed by silence, so all channels stay in sync. Speech is
mono at 24 kHz; the kernel resamples it to the document rate and writes it to
every selected channel.

**Advanced** holds temperature (variation, default from the model), sampler
steps, the end-of-speech threshold, a seed and a level. The same seed and
parameters reproduce the same speech on the same build and platform. The seed
used is recorded in macros, so a replay speaks identically.

Changing the text or any parameter after Generate discards the prepared edit.
Cancel stops whichever stage runs: the download, the synthesis or the edit.

## Models and storage

| Model | Layers | Download |
| --- | --- | --- |
| English (Jan 2026) | 6 | 236 MB |
| English (Sep 2026) | 6 | 219 MB |
| English, drifting (Sep 2026) | 6 | 217 MB |
| English (Sep 2026), 24 layers | 24 | 1.3 GB |
| German | 6 | 219 MB |
| German, 24 layers | 24 | 672 MB |

Each voice adds about 0.5 MB. Every file is pinned to a Hugging Face revision
and checked by size and SHA-256 before it is loaded; a corrupt download is
never used.

- **Web:** the speech worker fetches the files from Hugging Face; the browser's
  HTTP cache keeps them, as in the go-pocket-tts web demo. Clearing site data
  removes them.
- **Desktop:** the app downloads into `speech-models` in its user data
  directory and serves them to the editor itself, so the page never talks to
  the network. See [desktop.md](desktop.md) for the location and removal.
- **CLI and MCP:** `aae speech download` fills a directory passed with
  `--speech-models`.

The 24-layer models are larger and slower than the 6-layer ones. If the
speech engine runs out of memory, the dialog says so and the next
Generate starts it fresh; choose a 6-layer model.

## How it works

The speech engine is a separate WebAssembly module (`speech.wasm`) in its own
worker, loaded only when the dialog opens, so the editor's start-up does not
pay for it. It returns 24 kHz mono samples, which go to the kernel as the
binary input of `process.start` with the `audio` generator. No sample is
processed in JavaScript. Natively, `aae` and `aae-mcp` link go-pocket-tts
directly; their output for a seed is identical to each other, and close to but
not bit-identical with the browser's, which runs without assembly kernels.

## License

go-pocket-tts is MIT-licensed. The PocketTTS model weights and voices are
licensed CC-BY-4.0 by Kyutai; the dialog credits them. They are downloaded at
runtime and never shipped with the editor.
