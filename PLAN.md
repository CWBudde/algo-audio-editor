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
> - **ABI:** `AAEKernel.call(method, json, data?) → json` for control and optional binary input, `AAEKernel.takeData()` for the preceding call's binary output, and `AAEKernel.render(u8, frames)` for audio. Methods and payloads are defined in `packages/kernel/internal/protocol` and mirrored by hand in `packages/protocol`. Bulk data (audio, peaks, files) crosses as transferable `ArrayBuffer`s, never as JSON arrays.
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
- [x] `internal/audiobuf/memory.go`: `CountMemory` deduplicates blocks by pointer across supplied documents, history and clipboard snapshots, reporting sample bytes, cached peak bytes, unique blocks and references. Go GC owns block lifetimes; block-list, metadata and runtime overhead are excluded. `TestMemoryCountsSharedBlocksOnce` covers repeated references, copied edges and dropped snapshots.
- [x] `doc.memory` exposes current-document sample bytes, cached peak bytes, unique blocks and references through the mirrored kernel ABI. `useDocumentMemory` serializes refreshes and discards stale replies; `StatusBar` displays the combined storage in B/KiB/MiB (0 B without a document). Engine, hook lifecycle, formatting and status-bar tests plus the browser smoke test cover the path.
- [x] `TestRandomChannelEdits`: deterministic random slice/concat sequences reproduce a flat reference buffer bit for bit, including NaN payloads, signed zero and infinity. `BenchmarkChannelRead` checks the playback read path; `BenchmarkChannelSlice` measures partial-edge slicing on a one-hour block list.
- [x] `TestChannelOffsetsBeyondInt32` validates reads, slices and concatenation beyond 2³¹ frames using shared blocks. Verified with Go race tests (99.1% storage coverage), lint/native and WASM vet, 28 frontend tests, formatting checks and production browser e2e. Reads allocate zero bytes; partial-edge slicing of a one-hour block list takes approximately 0.1–0.16 ms on an i7-1255U.

### Phase 1.2: Peak pyramid — ✅ DONE (2026-10-02)

- [x] `internal/audiobuf/peaks.go`: all block constructors cache 256/4096/65536-frame min/max and float64 energy summaries once. The initial upstream `algo-dsp/stats/time.Calculate` calls became allocation-free `Summary` calls with `algo-dsp v0.7.2` in Phase 1.3, retaining identical extrema/energy without higher-order statistics or conversion scratch. RMS derives from energy and actual bucket length, including short tails. Shared blocks retain their peak caches; partial-edge slices build new caches. Tests cover level selection, tails, edits, special float values and offsets beyond 2³¹ frames; `TestPeaksCoarseRequestsUseOnlyCache` proves coarse requests never read raw samples.
- [x] `peaks.get {channel, startFrame, endFrame, buckets}` selects the coarsest cached level supplying at least one summary per pixel, with raw summaries below 256 frames per pixel. ABI v2 added `takeData`; the worker transfers one buffer holding min/max/RMS float32 triples, uint32 lengths and float64 absolute frame positions. True per-block ranges preserve shortened edited blocks and let the view clip summaries crossing its viewport. `decodePeaks` exposes zero-copy typed-array views. Engine tests cover validation, metadata and stale-data clearing; frontend tests prove transfers detach the sending buffer. The production browser smoke verifies real-kernel peak RPC routing; Phase 1.3 adds loaded-document transfers and exact summaries under ABI v3.
- [x] `BenchmarkPeaksHourStereo2000`: exact one-hour 48 kHz stereo with distinct per-block caches at 2000 px takes approximately 0.165 ms and two output-buffer allocations (131072 B/op) on an i7-1255U, below the 5 ms budget. Go race tests pass with 99.5% storage coverage; lint/native and WASM vet, 53 frontend tests, typechecks, formatting and three production browser e2e tests pass.

### Phase 1.3: WAV import/export (`github.com/cwbudde/wav`) — ✅ DONE (2026-10-03)

- [x] `packages/kernel/go.mod` consumes tagged `wav v0.1.1` and `algo-dsp v0.7.2`. Released the required upstream IEEE sample-preservation, odd RIFF padding and reusable block-decoder fixes in `wav`; added allocation-free float32/float64 `stats/time.Summary` in `algo-dsp`. No local DSP or codec copy, pseudo-version or replace directive.
- [x] ABI v3 mirrors `doc.open {name}`, `doc.info` and `doc.export` in Go and TypeScript. `KernelClient.openDocument` transfers and detaches the file buffer; the bridge accepts a separate `Uint8Array`. `internal/engine/wav.go` validates RIFF boundaries, format/extensible fields and whole frames before streaming PCM 8/16/24/32 and float 32/64 into immutable blocks. `NewBlockFromInterleaved` copies directly into owned mono storage; only a bounded decode scratch buffer exists. Failed opens leave the previous document intact; unrelated metadata is skipped until Phase 6.
- [x] `doc.export {format: "wav", bitDepth, float}` streams channel reads through the upstream encoder and a bounded in-memory `io.WriteSeeker` in `wav_io.go`. `takeData` returns the binary output once, and the worker transfers it without JSON sample arrays. Empty files, odd byte counts and RIFF/WASM size limits are handled.
- [x] Independent WAV fixtures in `wav_test.go` verify bit-exact PCM16/PCM24/float32 payload round trips, including extended-range floats, infinity, NaN payloads, signed zero and subnormals. Tests cover PCM8/32, float64, extensible formats, 1–8 channels, block tails, data-before-format, ancillary chunks, truncated data, invalid fields and atomic rejection. `document_rpc_test.go` covers the binary open → info → peaks → export path and ownership. `FuzzWAVOpen`, `just fuzz-wav` and the CI decoder fuzz smoke exercise malformed input; `just test-go-wasm` runs the native golden vectors under V8/WASM.
- [x] `file-access.ts`, `use-document.ts` and `App.tsx` wire Open, drag/drop, Save and Export through native browser pickers or input/download fallbacks. Cancellation, serialized operations, stale/unmounted replies, file errors and interrupted tone setup have regression tests. Production browser `documents.spec.ts` checks detached input, actual loaded-document peak transfers, exact 16/24/32f export payloads, empty files and failed-open preservation. The transport remains explicitly labeled as a test tone until Phase 1.5.
- [x] `just bench-import-browser` enforces the unchanged < 1 s gate for the full ten-minute 48 kHz varied stereo PCM16 import, including file reading and the UI update. On the i7-1255U, the last three consecutive isolated Chromium runs pass at 624.645/665.810/860.320 ms (kernel RPC 478.410/531.050/716.810 ms). Preserve the earlier isolated failures at 1076.375/1743.070 ms and the contended 1876.360 ms run: timing has substantial environmental variance, not a proven worst-case bound. The pre-summary baseline was 1416.490 ms. Final native import benchmark: 0.615 s, 235144280 B/op and 4437 allocations; single-iteration Node/V8 WASM: 1.311 s. Browser timing, not native or Node timing, verifies the browser acceptance gate. Cached one-hour stereo/2000px peaks remain below 5 ms (native 0.185 ms, WASM 2.244 ms); channel reads and tone renders remain allocation-free.
- [x] Final verification: Go race tests (99.5% storage, 91.3% engine coverage), full Go golden tests under V8/WASM, native/WASM vet and lint, 80 frontend tests, both typechecks, formatting and module-tidy checks, current sibling tags, eight production browser tests and the Electron smoke pass. A five-second fuzz run executed approximately 249000 malformed inputs without failures; CI runs a ten-second smoke. `just bench`, `just bench-wasm` and the opt-in browser gate make measurements reproducible.

### Phase 1.4: Waveform view — ✅ DONE (2026-10-03)

- [x] `components/waveform-view.tsx` replaces the loaded-document placeholder with one canvas per channel. `waveform-drawing.ts` draws only kernel min/max/RMS summaries at their true frame extents, clips viewport-crossing buckets and omits NaN gaps without modifying the source. Backing-store sizing follows DPR; ResizeObserver, window resize and re-armed resolution listeners redraw the view. Component tests cover DPR changes, empty files, same-format document replacement and eight-channel scrollbar-gutter alignment; production browser tests inspect actual painted pixels and backing dimensions.
- [x] `waveform-geometry.ts` provides frame-coordinate zoom/pan/hit testing, sample/second/h:m:s.ms time ticks and linear/dB amplitude labels. Ruler controls switch units without audio processing. Tests cover empty and one-frame ranges, cursor anchoring, signed/nonfinite display values, offsets beyond 2³¹ and one-frame spans at `Number.MAX_SAFE_INTEGER`. Bar/beat formatting remains part of the later musical timeline.
- [x] Nonpassive native Ctrl+wheel zoom preserves the frame under the pointer; toolbar, View menu and Ctrl/Cmd +/−/0 shortcuts expose zoom in/out/fit. Canvas drag ranges support zoom-to-selection as view state; the full editing selection model remains Phase 2.1. Horizontal/Shift+wheel, a bounded native virtual scrollbar and overview interactions pan without allocating a file-wide canvas. Browser tests verify actual native wheel coordinates, menu/keyboard commands, scrollbar/overview movement and fitted drag ranges.
- [x] A first-channel, full-file overview canvas shows the viewport rectangle; dragging or clicking it pans the main lanes, with arrow/Home/End keyboard access. Pointer cancellation and lost capture clear both overview and selection drags. Component and production browser tests cover the interactions, and a same-named reopened document resets viewport/selection and invalidates previous peaks.
- [x] `hooks/use-peaks.ts` keeps one in-flight RPC per visual lane and only the latest pending viewport. Request identity and sequence guards synchronously hide stale data, drop obsolete responses and prevent unmounted/StrictMode work from draining queued requests. Packed peak buffers are decoded through zero-copy views. Twelve deferred-RPC tests cover rapid A/B/C updates, independent lanes, document/client replacement, malformed replies, errors and lifecycle cleanup.
- [x] Verification: full `just ci` passes (Go race coverage unchanged at 99.5% storage/91.3% engine, native/WASM vet, lint, both typechecks, 116 frontend tests, formatting/tidy and production build). Twelve production browser tests pass, including four waveform interaction/rendering tests and all prior WAV/audio regressions. The Electron smoke imports a stereo WAV, renders both channels and verifies zoom, in addition to its isolated `app://` and tone checks. Sibling dependencies remain at their current tags; generated UI components and the audio ABI are unchanged.

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
