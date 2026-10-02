# Implementation Plan: algo-audio-editor

> **Architecture Summary:**
>
> - **Kernel:** Go compiled to WebAssembly (`packages/kernel`). It owns everything that touches audio: the document model, edit history, DSP, codecs, peak data and playback rendering. Its DSP comes from the `github.com/cwbudde/algo-*` family (mainly `algo-dsp` and `wav`).
> - **Frontend:** Vite + React 19 + TypeScript, Tailwind CSS v4, shadcn (Base UI primitives). The UI is a view and a controller only.
> - **Desktop:** Electron (`apps/desktop`) serves the *same* production build over a privileged `app://` scheme, so browser and desktop share one code path.
> - **Rule:** No sample processing in JS. JS may copy samples (ring buffer, worklet, transfer) and draw what the kernel computed (peaks, spectra), but every audio computation happens in the kernel.
> - **Threads:**
>   ```
>   Main thread (React UI) ──postMessage RPC──▶ Kernel Worker (Go WASM)
>        │                                          │ js.CopyBytesToJS
>        ▼                                          ▼
>   AudioWorklet "playback"  ◀──── SharedArrayBuffer ring buffer (Atomics indices)
>   ```
>   The kernel never runs on the audio thread. Go's GC and runtime cannot meet real-time deadlines, so the worker renders ahead into the ring and the worklet only copies.
> - **ABI:** `AAEKernel.call(method, json) → json` for control, and `AAEKernel.render(u8, frames)` for audio. Methods and payloads are defined in `packages/kernel/internal/protocol` and mirrored by hand in `packages/protocol`. Bulk data (audio, peaks, files) crosses as transferable `ArrayBuffer`s, never as JSON arrays.
> - **Cross-origin isolation** (needed for SharedArrayBuffer) comes from:
>   - COOP/COEP headers in Vite dev/preview,
>   - `coi-serviceworker.js` on GitHub Pages,
>   - the `app://` protocol handler in Electron.

**Product shape (decided 2026-10-02):** a waveform editor first, in the spirit of ocenaudio, Sound Forge or Audition's waveform view. Multitrack comes in Phase 11 and is built on the same block-based document model.

---

## ✅ Phase 0: Scaffolding & End-to-End Pipeline — COMPLETE (2026-10-02)

**Goal:** A repo where Go WASM, the worker, the AudioWorklet and both the browser and Electron shells are wired together and tested before any editor feature exists.

**Acceptance criterion:** "Play test tone" produces audio from the Go kernel through Worker → SAB ring → AudioWorklet in Chromium and Electron, with zero underruns. An automated test proves it in both shells.

### Phase 0.1: Repository & tooling — ✅ DONE (2026-10-02)

- [x] Bun workspaces monorepo: `apps/editor-web`, `apps/desktop`, `packages/kernel` (Go), `packages/protocol` (TS ABI types, no build step)
- [x] `justfile` as the single entry point. Recipes: `install`, `wasm-build`, `dev`, `build`, `preview`, `desktop-dev`, `desktop-hot`, `test`, `test-go-race`, `e2e`, `e2e-desktop`, `lint`, `fmt`, `check-formatted`, `check-tidy`, `check-deps`, `check-unreleased`, `ci`
  - [x] The `wasm-build` ldflags `-X` path equals the `buildinfo` import path. Agogo-Web's justfile has a mismatched path there, so its version is never stamped.
- [x] Biome (lint + format, including import organizing via `treefmt`), `treefmt.toml` (gofumpt, gci, biome, shfmt), `lefthook.yml` pre-commit (biome, typecheck, go vet for native and js/wasm), `packages/kernel/.golangci.yml` (v2)
- [x] `scripts/release-guard.sh` copied from algo-dsp. `just check-deps` runs it against `packages/kernel/go.mod`. All `cwbudde` siblings are at their latest tags (algo-dsp v0.7.1, algo-fft v0.8.0, algo-vecmath v0.1.3, algo-approx v0.2.0).

### Phase 0.2: Go kernel skeleton — ✅ DONE (2026-10-02)

- [x] `internal/protocol`: ABI `Version`, method names (`hello`, `engine.configure`, `tone.configure`), payload structs, and the `Response` envelope
- [x] `internal/engine`: platform-independent `Engine`
  - [x] `Call(method, payload) []byte` never panics on bad input; every error becomes an error envelope
  - [x] `Render([]float32) int` renders interleaved frames
- [x] Test tone: a one-second wavetable from `algo-dsp/dsp/signal`, with the frequency rounded to whole hertz so the loop is phase-continuous
- [x] `cmd/kernel/main.go` (`js && wasm`) installs `globalThis.AAEKernel`
  - [x] `render()` uses the reused-buffer + single `js.CopyBytesToJS` pattern from `algo-dsp/web/wasm/main.go`
  - [x] It signals readiness through `__aaeKernelReady`, because `go.run()` only settles when the program exits
- [x] Table-driven tests: hello, all validation errors, unchanged state after a rejected configure, render layout for 1/2/6 channels, phase continuity across chunked renders and the table wrap (`TestToneContinuity`). `BenchmarkRender`: 0 allocs/op.

### Phase 0.3: Web app shell — ✅ DONE (2026-10-02)

- [x] Vite 8, React 19.2, TS 6 (strict, `erasableSyntaxOnly`), Tailwind v4, shadcn CLI init (`base-nova`, Base UI, `cn` package). Dark theme.
- [x] `src/kernel/kernel.worker.ts`: module worker
  - [x] loads `wasm_exec.js` via dynamic `import()` and `kernel.wasm` via `instantiateStreaming`
  - [x] reports a dead kernel as a `fatal` event
- [x] `src/kernel/client.ts`: typed promise RPC client with per-request timeouts, `KernelError`/`KernelTimeoutError`, fatal propagation, and a protocol-version check on boot
- [x] `src/kernel/runtime.ts`: one kernel per page; the cached promise survives StrictMode and is reset when boot fails
- [x] `src/audio/ring-buffer.ts`: SPSC ring of interleaved float32 frames over a SAB. It de-interleaves into planar worklet outputs and keeps underrun and consumed-frame counters.
- [x] `src/audio/playback-worklet.ts` (loaded with `?worker&url`) and `src/audio/audio-engine.ts`
  - [x] The context stays suspended until the worker reports the ring primed, so playback starts without starved frames
- [x] App shell:
  - [x] menubar with the final menu structure; entries are disabled until their phase lands
  - [x] transport bar with test-tone frequency and level
  - [x] placeholder document area
  - [x] status bar with kernel version, sample rate, isolation state, played/buffered/underrun frames and platform
- [x] COOP/COEP headers for dev and preview; `coi-serviceworker.js` for Pages (`%BASE_URL%`-relative); `VITE_BASE` for the Pages sub-path

### Phase 0.4: Electron shell — ✅ DONE (2026-10-02)

- [x] `apps/desktop/src/main.ts`: a privileged `app://editor/` scheme serves `editor-web/dist` with COOP, COEP, a strict CSP (`'wasm-unsafe-eval'`) and explicit MIME types
  - [x] Navigation is locked to the app; external `https:` links open in the system browser
  - [x] `AAE_DEV_URL` switches the window to the Vite dev server (`just desktop-hot`)
- [x] `preload.ts` exposes `window.aaeDesktop` (platform, versions) via `contextBridge`. Uses `contextIsolation` and `sandbox: true`, without `nodeIntegration`.
- [x] Fixed while here: `bun build` inlines `__dirname` as the *source* directory, so the preload path is derived from `app.getAppPath()` instead
- [x] Electron 44 ships no postinstall. `just install` runs `install-electron` explicitly.

### Phase 0.5: Tests & CI — ✅ DONE (2026-10-02)

- [x] Vitest: ring buffer (capacity, wrap, underrun, attach, reset, invalid layouts) and RPC client (boot, version mismatch, error mapping, out-of-order replies, timeout, fatal, terminate)
- [x] Playwright (browser), `apps/editor-web/e2e/smoke.spec.ts`:
  - [x] kernel ready and `crossOriginIsolated`
  - [x] test tone consumed > 48 000 frames with 0 underruns, and Stop resets the counters
  - [x] no console errors
  - [x] passes against both `vite preview` and `vite dev`
- [x] Playwright (Electron), `apps/desktop/e2e/smoke.spec.ts`: page loads over `app://`, isolated, preload bridge present, tone plays, no console errors (catches CSP and preload failures)
- [x] `.github/workflows/`:
  - [x] `ci.yml`: kernel vet/test -race/tidy/golangci, web biome/typecheck/vitest, treefmt, browser + Electron e2e under xvfb
  - [x] `pages.yml`: Pages deploy
  - [x] `dep-drift.yml`: weekly sibling drift check

---

## Phase 1: Document Model, WAV I/O, Waveform & Playback

**Goal:** Open a WAV file, see its waveform, zoom/scroll it, and play it back with a moving play cursor.

**Acceptance criterion:**
- A 10-minute 48 kHz stereo WAV opens in < 1 s on a mid-range laptop.
- The waveform renders at any zoom level from the peak pyramid without touching raw samples.
- Playback position drawn on screen matches the audible position within one audio quantum.

### Phase 1.1: Block-based audio storage (`internal/audiobuf`) — ✅ DONE (2026-10-02)

- [x] `internal/audiobuf/block.go`: immutable mono float32 blocks capped at 65536 frames. `NewBlock` copies caller samples; `Read` only copies out. `TestBlockValidationAndOwnership` checks size limits and alias isolation.
- [x] `internal/audiobuf/channel.go`: immutable block lists with int64 prefix offsets, zero-allocation `Read`, `Slice` sharing whole blocks and copying only partial boundaries, and `Concat` sharing all samples. `NewChannelFromBlocks` supports block-by-block import. `TestChannelRead` and `TestChannelSliceSharing` cover boundaries, invalid ranges and pointer sharing.
- [x] `internal/audiobuf/document.go`: value-type `Document` with equal-length channels, sample rate and defensively copied metadata. `Slice`, `Concat` and `WithMetadata` return snapshots sharing unchanged storage. `TestDocumentValidation` and `TestDocumentSnapshots` check format validation and immutable snapshots.
- [x] `internal/audiobuf/memory.go`: `CountMemory` deduplicates blocks by pointer across supplied documents, history and clipboard snapshots, reporting sample bytes, unique blocks and references. Go GC owns block lifetimes; block-list, metadata and runtime overhead are excluded. `TestMemoryCountsSharedBlocksOnce` covers repeated references, copied edges and dropped snapshots.
- [x] `doc.memory` exposes current-document sample bytes, unique blocks and references through the mirrored kernel ABI. `useDocumentMemory` serializes refreshes and discards stale replies; `StatusBar` displays B/KiB/MiB values (0 B without a document). Engine, hook lifecycle, formatting and status-bar tests plus the browser smoke test cover the path.
- [x] `TestRandomChannelEdits`: deterministic random slice/concat sequences reproduce a flat reference buffer bit for bit, including NaN payloads, signed zero and infinity. `BenchmarkChannelRead` checks the playback read path; `BenchmarkChannelSlice` measures partial-edge slicing on a one-hour block list.
- [x] `TestChannelOffsetsBeyondInt32` validates reads, slices and concatenation beyond 2³¹ frames using shared blocks. Verified with Go race tests (99.1% storage coverage), lint/native and WASM vet, 28 frontend tests, formatting checks and production browser e2e. Reads allocate zero bytes; partial-edge slicing of a one-hour block list takes approximately 0.1–0.16 ms on an i7-1255U.

### Phase 1.2: Peak pyramid

- [ ] Each block stores min/max/RMS summaries at 256, 4096 and 65536 frames per bucket, computed once when the block is created
- [ ] `peaks.get {channel, startFrame, endFrame, buckets}` → min/max/RMS arrays as a transferable `Float32Array`. It picks the coarsest level that still gives ≥ 1 summary per pixel and falls back to raw samples when zoomed in past 256 frames per pixel.
- [ ] Benchmark: peaks for a 1-hour stereo document at 2000 px wide in < 5 ms

### Phase 1.3: WAV import/export (`github.com/cwbudde/wav`)

- [ ] Add `github.com/cwbudde/wav` to `packages/kernel/go.mod`; `just check-deps` must stay green
- [ ] `doc.open {name, bytes}` with the file passed as a transferable `ArrayBuffer`: decode PCM 8/16/24/32, float 32/64 and extensible WAV into blocks, streaming through `PCMBuffer` so the full decode never exists twice in memory
- [ ] `doc.export {format: wav, bitDepth, float}` → `ArrayBuffer`, through an in-memory `io.WriteSeeker` (the encoder needs `Seek`)
- [ ] Golden tests: a round trip of 16/24/32f files is bit-exact; odd sizes, 1–8 channels, a truncated `data` chunk
- [ ] Frontend: Open via `<input type=file>` / File System Access API (`showOpenFilePicker`), drag-and-drop onto the document area, Save via `showSaveFilePicker` or a download fallback

### Phase 1.4: Waveform view

- [ ] `<WaveformView>`: one canvas per channel lane, device-pixel-ratio aware, redrawn from peak data on zoom/scroll/resize
- [ ] Time ruler (samples / seconds / h:m:s.ms / bars later), dB or linear amplitude ruler
- [ ] Zoom: Ctrl+wheel around the cursor, zoom-to-fit, zoom-to-selection; horizontal scroll via wheel, scrollbar and overview strip
- [ ] Overview strip (full-file mini waveform) with a draggable viewport rectangle
- [ ] Peak request coalescing: one in-flight request per lane; stale responses are dropped by sequence number

### Phase 1.5: Transport

- [ ] Kernel `transport.play {start, end?, loop}`, `transport.stop`, `transport.seek`. The render path reads document blocks instead of the test tone.
- [ ] Play position: the worklet publishes the consumed-frame count through the SAB header, upgraded to `BigInt64` so it does not wrap. The kernel maps it to document position, accounting for ring latency. The UI reads it per animation frame without RPC.
- [ ] Play cursor, follow-playback scrolling (page or continuous), spacebar play/stop, Home/End
- [ ] Sample-rate mismatch: a document whose rate differs from the `AudioContext` plays through `algo-dsp/dsp/resample` in the render path
- [ ] Remove the Phase 0 test tone from the UI. Keep `tone.configure` as a diagnostic method.

---

## Phase 2: Selection & Editing

**Goal:** Cover the editing basics: select, cut, copy, paste, delete, undo, and markers.

**Acceptance criterion:**
- Every edit is undoable and redoable to an exact match.
- Cut/paste on a 1-hour file completes in < 50 ms, because only block lists change.
- Undo history of 100 steps on a 1-hour file stays under 2× the document's memory.

### Phase 2.1: Selection model

- [ ] Time selection (start/end frames) plus channel mask (all / left / right / any subset)
- [ ] Mouse: click to set the cursor, drag to select, Shift-click to extend, double-click a region to select it, and drag the selection edges
- [ ] Snap to zero crossings (optional, kernel computes), markers and ruler ticks
- [ ] Selection readout and numeric entry (start / end / length, in the current time format)

### Phase 2.2: Edit operations

- [ ] Kernel operations as values (port the design of `mfw/pkg/ops`: `Operation{Apply(doc) (doc, error)}`):
  - [ ] delete, cut, copy, paste (insert/replace/mix), crop/trim to selection
  - [ ] insert silence, duplicate, swap channels, mute (silence) selection
- [ ] Internal clipboard holds a block list (no copy). System clipboard export/import as WAV is a later nicety.
- [ ] Paste with sample-rate or channel-count mismatch: convert (resample / up/down-mix) with a prompt

### Phase 2.3: Undo/redo history

- [ ] `History` of `{label, before Document, after Document}`. Structural sharing makes snapshots cheap. Bounded by count and by unique-block memory.
- [ ] `edit.undo`, `edit.redo`, `history.list`, `history.jump`; a history panel in the UI
- [ ] Dirty tracking against the last save point

### Phase 2.4: Markers & regions

- [ ] Point markers and regions with names and colors, stored on the document and shifted by edits
- [ ] Marker list panel; jump-to; export as a CSV/label file; WAV `cue`/`LIST adtl` round trip (Phase 6)

### Phase 2.5: Keyboard & commands

- [ ] Central command registry (id, label, shortcut, enabled predicate) that drives the menubar, shortcuts and the command palette (Ctrl+K)
- [ ] Platform-aware shortcuts (Cmd on macOS); a shortcut editor is deferred

---

## Phase 3: Basic Processing

**Goal:** The everyday destructive processes, applied to the selection (or the whole file), each undoable.

**Acceptance criterion:**
- Every process has a Go golden test against a reference vector.
- Processing a 10-minute stereo file takes < 1 s.
- A long process shows progress and can be cancelled without corrupting the document.

### Phase 3.1: Processing infrastructure

- [ ] `Process` interface: streams the selection block by block (float32 → float64 → algo-dsp → float32), writes new blocks, and returns a new `Document`
- [ ] Long-running jobs run in slices: the kernel yields between chunks, posts `progress` events and checks a cancellation flag. The UI shows a progress dialog with Cancel.
- [ ] Preview: render the processed selection into the playback path without committing it

### Phase 3.2: Processes

- [ ] Amplify / gain (dB), with a clipping warning based on the predicted peak
- [ ] Normalize: peak (dBFS) and loudness (LUFS via `algo-dsp/measure/loudness`)
  - [ ] **Upstream (algo-dsp):** a `NormalizeLoudness` helper. Tag algo-dsp, then bump here.
- [ ] Fade in / fade out / crossfade at edit points: linear, equal-power, logarithmic, S-curve
  - [ ] **Upstream (algo-dsp):** a fade-curve package (`dsp/fade`) with these shapes, tested and benchmarked
- [ ] Reverse, invert polarity, DC offset removal (`signal.RemoveDC`)
- [ ] Channel operations: mono → stereo, stereo → mono (mix / left / right), swap, extract a channel to a new document
- [ ] Change sample rate (`algo-dsp/dsp/resample`, quality profiles)
- [ ] Silence generation, plus a generator dialog (tone/noise/sweep via `dsp/signal`)

### Phase 3.3: Export quality

- [ ] Bit-depth reduction on export with dither (`algo-dsp/dsp/dither`, including noise-shaping presets)
- [ ] Export dialog: format, bit depth, dither type, and the selection or the whole file

---

## Phase 4: Effects

**Goal:** Expose algo-dsp's effect catalogue through generated, consistent UIs with real-time preview, and apply effects offline.

**Acceptance criterion:**
- Every effect registered in `algo-dsp/dsp/effectchain`'s default registry is usable from the Effects menu.
- Parameter changes during preview are audible within 50 ms.
- An offline apply matches the previewed sound sample for sample, given the same parameters and start position.

### Phase 4.1: Effect descriptors

- [ ] A kernel-side descriptor per effect: id, name, category, parameters (id, label, unit, range, default, scale lin/log/dB, enum options). Served by `effects.list`.
- [ ] Generic parameter UI from descriptors (shadcn slider + numeric input + unit). An effect can register a custom view instead (EQ curve, compressor transfer curve).
- [ ] Presets: built-in factory presets plus user presets, stored in OPFS / Electron userData

### Phase 4.2: Real-time preview via `effectchain`

- [ ] The playback render path runs the selection through an `effectchain.Chain` (JSON graph) while an effect dialog is open
- [ ] Bypass toggle, wet/dry, and input/output meters in the dialog
- [ ] Multi-channel handling: one chain per channel, or a stereo-aware runtime (spatial effects need the pair)

### Phase 4.3: Effect families

- [ ] EQ: parametric (N bands, RBJ/`design` biquads) with an interactive response curve (kernel computes the magnitude response) and a graphic EQ (`design/band`)
- [ ] Filters: high-pass and low-pass (Butterworth/Bessel/Chebyshev/elliptic), Moog ladder, A/C weighting
- [ ] Dynamics: compressor, expander, gate, limiter, lookahead limiter, multiband compressor, de-esser, transient shaper, dynamic EQ
- [ ] Modulation: chorus, flanger, phaser, tremolo, auto-wah, ring modulator, frequency shifter, rotary speaker
- [ ] Time: delay, reverb (Freeverb/FDN), convolution reverb with IR loading from a file
- [ ] Pitch: pitch shift (WSOLA and phase vocoder)
- [ ] Spatial: stereo widener, panner, Haas, crosstalk
- [ ] Distortion and lo-fi: distortion, bit crusher, transformer simulation

### Phase 4.4: Effect rack

- [ ] Chain several effects in one dialog (it already *is* an `effectchain` graph), reorder them, and apply the chain in one undo step

---

## Phase 5: Analysis & Metering

**Goal:** Professional metering during playback and offline analysis of documents.

**Acceptance criterion:**
- Loudness readings match the EBU Tech 3341/3342 test vectors within tolerance.
- The spectrogram of a 10-minute file renders progressively without blocking playback.

### Phase 5.1: Playback meters

- [ ] Peak/RMS meters per channel with peak hold, computed in the kernel render path and published through a small SAB meter block (no RPC per frame)
- [ ] Loudness meter (momentary, short-term, integrated, LRA) from `measure/loudness`
- [ ] True peak
  - [ ] **Upstream (algo-dsp):** a 4× oversampled true-peak meter. `measure/loudness/meter.go` notes "True Peak requires oversampling".
- [ ] Phase correlation meter and goniometer (vectorscope)

### Phase 5.2: Spectral views

- [ ] **Upstream (algo-dsp):** a public streaming STFT (window + hop + algo-fft) and its inverse, the basis for the spectrogram, spectral editing and noise reduction
- [ ] Spectrum analyzer of the selection or playback (FFT size, window, averaging, fractional-octave smoothing via `dsp/spectrum`)
- [ ] Spectrogram view as an alternative or split lane view: tiles rendered by the kernel as RGBA (colormap applied in Go), cached per zoom level, rendered progressively

### Phase 5.3: Statistics & detection

- [ ] Statistics dialog: peak, RMS, DC offset, crest factor, zero crossings, clipped samples, integrated loudness (`stats/time`)
- [ ] Pitch detection and tracking display (`effects/pitch` YIN detector)
- [ ] Clipping detection with markers at the clipped regions

---

## Phase 6: Codecs, Metadata & Persistence

**Goal:** Open what users actually have, save projects safely, and never lose work.

**Acceptance criterion:**
- FLAC, MP3, AIFF, OGG/Opus and M4A/AAC files open.
- FLAC export round-trips bit-exactly.
- After a crash (killed tab or Electron process), the last autosave restores within 5 s of the edit.

### Phase 6.1: Decoders

- [ ] FLAC in Go (`mewkiz/flac`), MP3 in Go (`hajimehoshi/go-mp3`), AIFF (`go-audio/aiff`, already a `wav` dependency). Port from `mfw/pkg/file`.
- [ ] Fallback for everything else: the main thread decodes with `decodeAudioData` / WebCodecs `AudioDecoder` and transfers planar float32 to the kernel. This JS step is not "processing", only codec glue.
- [ ] Format detection by magic bytes, not extension

### Phase 6.2: Encoders

- [ ] WAV (Phase 1), FLAC (`mewkiz/flac` encoder), AIFF
- [ ] Lossy export through WebCodecs `AudioEncoder` (Opus, AAC where supported) plus a minimal Ogg/MP4 muxer. Lossy formats are exported only, never edited in place.

### Phase 6.3: Metadata

- [ ] WAV LIST/INFO, BWF `bext`, `cue`/`adtl` ↔ markers and regions, ID3 for MP3, and Vorbis comments for FLAC
- [ ] Metadata editor panel

### Phase 6.4: Projects & autosave

- [ ] `.aaep` project = a zip-like container of document blocks, history (optional), markers and view state
- [ ] OPFS-backed autosave of dirty documents (incremental: only new blocks are written) and crash recovery on startup
- [ ] Recent files (browser: OPFS handles; desktop: native paths)

---

## Phase 7: Recording

**Goal:** Record from an input device into a new document or at the cursor.

**Acceptance criterion:** A 30-minute recording at 48 kHz stereo has no dropped frames, and the recorded audio lines up with playback within the measured round-trip latency.

- [ ] Capture worklet: input → SAB ring (the reverse of playback) → the kernel worker appends blocks
- [ ] Input device selection (`getUserMedia` constraints: echo cancellation, noise suppression and AGC turned **off**)
- [ ] Input meters, record-arm and monitoring toggle
- [ ] Record modes: new file, insert at cursor, replace selection (punch-in with pre-roll)
- [ ] Latency measurement (loopback ping) and compensation

---

## Phase 8: Restoration & Advanced Editing

**Goal:** The tools that set a serious editor apart.

**Acceptance criterion:** Spectral repair of a click is inaudible on the reference fixtures, and noise reduction achieves ≥ 15 dB on the stationary-noise fixture without audible musical noise at default settings.

- [ ] Spectral editing: rectangle/lasso selection in the spectrogram; attenuate, remove or heal (interpolate) through the inverse STFT
- [ ] Noise reduction (profile-based spectral subtraction / Wiener)
  - [ ] **Upstream (algo-dsp):** port the legacy Delphi `FFT Effects/{Noise Reduction, Spectral Noise Gate}` into `dsp/effects/restoration`
- [ ] Click/pop removal and clip repair (declip by interpolation)
- [ ] Time-stretch without pitch change
  - [ ] **Upstream (algo-dsp):** expose the time-stretch currently private inside `pitch_shifter.go` / `pitch_shift_spectral.go` as a public API
- [ ] Hum removal (notch comb at 50/60 Hz plus harmonics)

---

## Phase 9: Desktop (Electron) Complete

**Goal:** The desktop build feels native and installs like a normal application.

**Acceptance criterion:** Signed installers for Linux (AppImage + deb), Windows (NSIS) and macOS (dmg) build in CI. File associations open documents, and auto-update works on all three.

- [ ] Native application menu generated from the command registry (Phase 2.5), with the in-page menubar hidden on desktop
- [ ] Native file dialogs and filesystem access through preload IPC (`openFile`, `saveFile`, `readFile`, `writeFile`), each with an explicit allow-list
- [ ] File associations (`.wav`, `.flac`, `.aiff`, `.mp3`, `.aaep`), open-with, single-instance lock, recent documents in the OS
- [ ] Window state persistence, unsaved-changes prompt on close
- [ ] Packaging with electron-builder: `web` resources come from `editor-web/dist` (`process.resourcesPath/web` is already handled in `main.ts`)
- [ ] Auto-update (electron-updater with GitHub Releases), plus code-signing notes for macOS notarization and Windows signing
- [ ] Release workflow: on a tag, build installers and attach them to the GitHub release

---

## Phase 10: Performance & Large Files

**Goal:** Multi-hour files, long histories and heavy effects stay responsive within wasm32's memory limit.

**Acceptance criterion:** A 3-hour 96 kHz stereo file (~4 GB as float32) opens, edits and plays, with less than 1 GB of WASM heap resident.

- [ ] Block paging: cold blocks are evicted to OPFS (browser) or a temp file (desktop) and faulted back in on demand. The peak pyramid always stays resident.
- [ ] Waveform rendering in an `OffscreenCanvas` inside a dedicated render worker that reads peaks directly
- [ ] Profile the kernel render path in the browser; SIMD where algo-dsp provides it (`GOARCH=wasm` SIMD status permitting)
- [ ] Benchmark suite with a regression guard, in the style of algo-dsp's `benchguard`
- [ ] Evaluate TinyGo for kernel size and speed (it is not a goal if the trade-offs are bad)

---

## Phase 11: Multitrack

**Goal:** Arrange several sources on a timeline and mix them down, reusing the block model.

**Acceptance criterion:** A session of 16 stereo tracks, each with an effect chain, plays without underruns on a mid-range laptop, and its mixdown matches offline rendering sample for sample.

- [ ] Session model: tracks → clips (each references a document range, plus gain, fades and an offset). Clip edits are non-destructive.
- [ ] Timeline view: tracks, clip drag/trim/split, snapping, grid (time / bars and beats)
- [ ] Mixer: gain, pan, mute, solo, meters, sends to buses; a per-track `effectchain`
- [ ] Automation lanes (gain, pan, effect parameters) with breakpoint editing
- [ ] Mixdown/bounce to a new waveform document or to a file
- [ ] Open a clip in the waveform editor (a destructive edit makes a new document version)

---

## Phase 12: Batch & Automation

**Goal:** Apply the same processing to many files, from the UI or headless.

**Acceptance criterion:** A batch job (normalize to −16 LUFS, fade the edges, convert to 44.1 kHz/16-bit FLAC) processes 100 files from the UI and gives an identical result through the native CLI.

- [ ] Operation chains serialized as JSON (the same `Operation` values as Phase 2/3)
- [ ] Batch dialog: file list, chain, output naming and format, progress per file
- [ ] Native CLI (`packages/kernel/cmd/aae`): the same engine compiled for desktop OSes, running chains on files without the UI
- [ ] Macros: record the user's operations into a chain

---

## Phase 13: Public Web Deployment (GitHub Pages)

**Goal:** A live, linkable build of the editor on GitHub Pages that a visitor can open and use on a real file without installing anything — the project's public demo and the reference target for "does it work outside dev?".

**Acceptance criterion:** `https://meko-tech.github.io/algo-audio-editor/` (or the chosen Pages URL) loads from a cold cache, reports `crossOriginIsolated === true`, imports a local WAV, plays it without underruns and exports it again — verified by a Playwright smoke run against the deployed URL in CI.

**Status:** the plumbing from Phase 0 exists (`pages.yml` deploy workflow, `VITE_BASE` sub-path handling, `coi-serviceworker.js`). This phase turns it into a published, verified, documented site.

### Enablement & verification

- [ ] Enable Pages for the repo (source: GitHub Actions) and confirm the `github-pages` environment deploys from `main`
- [ ] Verify cross-origin isolation in production: `coi-serviceworker.js` registers under the `/<repo>/` scope, reloads once, and SharedArrayBuffer is available. Ship a visible fallback (not a blank page) when isolation fails — e.g. browsers or extensions that block the service worker.
- [ ] Verify the sub-path build end to end: `kernel.wasm`, `wasm_exec.js`, the worklet `?worker&url` asset and every `%BASE_URL%` reference resolve under `/<repo>/`
- [ ] Playwright job against the deployed URL (`PLAYWRIGHT_BASE_URL`), run after deploy and on a schedule, reusing the Phase 0 smoke assertions
- [ ] `404.html` fallback so deep links do not land on GitHub's 404

### Delivery quality

- [ ] Cache strategy: hashed assets cached long-term, `index.html` and `coi-serviceworker.js` never cached; a deploy must not leave a stale worker serving an old `kernel.wasm`
- [ ] Kernel size budget: record the gzipped `kernel.wasm` size in CI and fail the build when it grows beyond an agreed threshold (`-ldflags="-s -w"`, consider `wasm-opt` if it stays in-tree)
- [ ] Browser support matrix documented (Chromium, Firefox, Safari) with the known isolation and codec gaps per browser
- [ ] A small bundled demo file the visitor can open with one click, so the demo needs no local audio

### Presentation

- [ ] Landing state explains what the app is, that everything runs locally (no upload), and links to the repo and PLAN.md
- [ ] Build stamp visible in the status bar/About (kernel version from `git describe`, commit SHA, build date)
- [ ] README: a "Try it" link to the live site, a screenshot and the browser matrix
- [ ] Open-Graph/Twitter card metadata and a favicon/app icon set
- [ ] Decide and document whether the Pages deploy tracks `main` or only tags; if it tracks `main`, label the site as a development build

---

## Phase 14: MCP Support (drive the editor from an LLM)

**Goal:** Expose the kernel's operation model over the Model Context Protocol, so an LLM agent can inspect and edit audio with the same `Operation` values the UI uses — "normalize this to −16 LUFS, trim the silence at both ends and export 44.1 kHz/16-bit FLAC" as tool calls, not as DSP written by the model.

**Acceptance criterion:** An MCP client (Claude Code or Claude Desktop) connects to the server, opens a WAV, queries its statistics, applies a chain of operations, exports the result, and the output is sample-for-sample identical to running the same chain through the UI and through `cmd/aae`. Every mutating tool is undoable via the kernel's history.

**Depends on:** Phase 3 (processing infrastructure), Phase 5 (analysis), Phase 12's `Operation` serialization and native CLI — the MCP server is a third front-end over the same engine, next to the web UI and the CLI.

### Server

- [ ] `packages/kernel/cmd/aae-mcp`: a native Go MCP server (stdio transport first) linking `internal/engine` directly — no browser, no WASM, same code path as the CLI. HTTP/SSE transport behind a flag for remote use.
- [ ] Session model: documents are opened by path and addressed by id; a session holds several documents, their selections and their undo history
- [ ] Rule 5 holds: the MCP layer is a thin adapter: tool schema ⇄ `protocol` payloads. No DSP and no audio state in the adapter.
- [ ] Tool schemas generated from or checked against `internal/protocol`, so an ABI change cannot silently skew the MCP surface (test that every exposed method exists)

### Tool surface

- [ ] **Read:** `open_document`, `document_info` (duration, rate, channels, format, metadata), `list_documents`, `get_statistics` (peak, true peak, RMS, LUFS, DC, clipping), `get_peaks` (downsampled, for a textual or image overview), `detect_silence`/`detect_clipping`
- [ ] **Edit:** `select_range` (seconds or samples, per channel), `apply_operation` (the Phase 2/3 `Operation` union: trim, cut, insert, silence, fade, gain, normalize, resample, reverse, dc-offset), `apply_chain`, `undo`/`redo`, `history`
- [ ] **Effects:** `apply_effect` with the Phase 4 effect descriptors, so parameters and ranges are discoverable instead of guessed
- [ ] **Write:** `export_document` (format, bit depth, rate, dither), `save_document`, `render_region`
- [ ] **Resources:** documents exposed as MCP resources (a waveform PNG the kernel rendered, plus a JSON summary), so a vision-capable model can *see* the waveform
- [ ] **Prompts:** a few canned workflows (mastering check, podcast cleanup, batch convert) as MCP prompts

### Safety & ergonomics

- [ ] Read-only by default: writing outside an explicitly allowed root requires `--allow-write <dir>`; exports never overwrite without an explicit flag in the call
- [ ] Every operation is dry-runnable: return the predicted change (new duration, resulting peak/LUFS) without mutating
- [ ] Deterministic, token-frugal responses: numbers rounded sensibly, no sample arrays in JSON (Rule 4), long results paginated
- [ ] Errors carry the kernel's wrapped message and a suggested correction (e.g. "selection exceeds document length (3.2 s > 2.8 s)")

### Optional: the running editor as an MCP endpoint

- [ ] Evaluate exposing the *desktop app's* live session over MCP (Electron main process hosting the stdio/HTTP server, forwarding to the kernel worker), so an agent can edit the document the user is looking at, with the UI updating live
- [ ] If taken: a visible indicator and a per-session consent prompt while an agent is attached, and mutations land in the same undo stack as the user's

### Tests & docs

- [ ] Go tests driving the server through the MCP protocol (golden tool schemas, a full open → chain → export round-trip against the Phase 3 golden vectors)
- [ ] Parity test: the same chain via MCP, via `cmd/aae` and via the UI operation path produces identical output
- [ ] `docs/mcp.md`: install snippet for Claude Code (`claude mcp add`) and the Claude Desktop config, the tool reference, and the permission flags

---

## Phase S: Quality, Testing, Build & Deployment (cross-cutting)

### Testing strategy

- **Kernel (Go):** table-driven unit tests; golden vectors for every process and effect (generated once, reviewed, checked in); property tests for the block model; fuzzing for every decoder (`go test -fuzz` smoke job in CI, as Agogo-Web does for PSD)
- **Coverage targets:** ≥ 90 % for `internal/audiobuf` and the processing packages; ≥ 80 % for the kernel overall
- **Frontend:** Vitest for logic (ring buffer, RPC, command registry, coordinate mapping); React Testing Library for complex components
- **End-to-end:** Playwright for browser and Electron. Audio-correctness e2e: render through an `OfflineAudioContext`-driven harness and compare with the kernel's offline render.
- **Performance:** kernel benchmarks with tracked allocs/op; e2e timing budgets for open, edit and peak requests

### Build & release

- Versioning: SemVer `v0.x` until the waveform editor (Phases 1–6) is complete; the CHANGELOG uses the Keep a Changelog format
- An application, not a library: `gorelease` API checks do not apply, but the family's dependency rules do. `just check-deps` must be green before a release, and a deliberately deferred sibling bump is recorded here.
- Upstream algo-dsp work flows up the dependency graph: implement in algo-dsp → tag via `just tag-release` there → bump here. Never pin a pseudo-version.

### Deployment & security headers

- GitHub Pages via `pages.yml` with `VITE_BASE=/<repo>/`; COOP/COEP via `coi-serviceworker.js` (publishing and its verification: Phase 13)
- Electron: COOP/COEP/CSP from the `app://` handler; `contextIsolation`, `sandbox`, no `nodeIntegration`; navigation locked to the app

### License audit

- [ ] Before the first public release: audit all Go and npm dependency licenses (MIT/BSD/Apache only for bundled code), and generate the third-party notices for the About dialog and installers

---

## Deferred / Later

- VST3/CLAP plugin hosting (desktop only, via a native helper process)
- MIDI input for transport control
- Video track for post-production sync
- Collaborative editing
- Scripting API (JS or Lua) on top of the operation model
- Localization (UI strings are English for now)
