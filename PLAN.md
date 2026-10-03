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
> - **ABI:** `AAEKernel.call(method, json, data?) → json` for control and optional binary input, `AAEKernel.takeData()` for the preceding call's binary output, and `AAEKernel.render(u8, frames, positions?)` for audio and optional int64 document-position tags. Methods and payloads are defined in `packages/kernel/internal/protocol` and mirrored by hand in `packages/protocol`. Bulk data (audio, peaks, files) crosses as transferable `ArrayBuffer`s, never as JSON arrays.
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

## ✅ Phase 1: Document Model, WAV I/O, Waveform & Playback — COMPLETE (2026-10-03)

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

### Phase 1.5: Transport — ✅ DONE (2026-10-03)

- [x] `internal/engine/transport.go` implements `transport.play {start, end?, loop}`, `transport.stop` and `transport.seek`, mirrored in the Go/TypeScript ABI v4. `RenderWithPositions` reads immutable channel blocks into reused scratch, interleaves them and emits one int64 cursor-after-frame tag per output frame. Same-rate playback is bit-exact for 1/2/6/8 channels, including special floats and block boundaries; EOF returns a short buffer with silent unused frames. Regression tests cover range loops, paused/active seeks, offsets beyond 2³¹, document replacement and atomic rejection. The WASM bridge validates requests before advancing state, caps each render at 65536 frames and reuses audio/tag buffers; real V8/WASM tests cover binary copies, validation and EOF.
- [x] `audio/ring-buffer.ts` publishes nonwrapping BigInt64 consumed-frame counters and copies kernel position tags into a bounded, context-frame-indexed history. The worklet only copies/de-interleaves samples and timeline tags; it never runs DSP, invokes WASM or posts messages. `AudioEngine.position()` maps `getOutputTimestamp()` to the stored audible tag without per-frame RPC, accounting for ring and device latency; browsers without that API fall back to the consumed cursor. Tests cover delayed startup/EOF, loops, history overwrite, concurrent publication and counters beyond 2³¹. Stop preserves the audible cursor rather than the render-ahead cursor.
- [x] `App.tsx`, `TransportBar` and `WaveformView` provide per-channel/overview play cursors, position readout, selected-range playback/looping, page/continuous/off follow modes, Space play/stop and Home/End seek. Cursor and readout painting runs directly in animation frames, avoiding React scheduling lag; layout effects retain the current cursor across unrelated commits. Component tests cover follow modes and cursor-only updates without peak refetches. `AudioEngine` and `kernel/stream-pump.ts` prime a correctly configured 1–8-channel graph before resuming and distinguish normal EOF from starvation; regression tests cover failed setup, play/stop/seek/import races, graph reuse and exact short-file consumption.
- [x] `internal/engine/transport_resample.go` uses tagged `algo-dsp v0.7.3` for exact-rational, allocation-free streaming conversion. The required bounded `ProcessInto`, overflow-safe output prediction, group-delay accessors and independent-state/shared-coefficient `Clone` were implemented, tested and released upstream before the dependency bump. The kernel scales anti-alias taps for extreme downsampling, trims leading delay, flushes the tail and maintains continuous loop/filter clocks and integer position tags. Golden/chunk-parity, final-impulse, loop/seek and extreme-downsample tests pass natively and under V8/WASM. Preparation atomically rejects rare rate ratios needing more than the explicit 64 MiB filter workspace limit (for example 383999→384000 Hz); no local DSP copy, pseudo-version or replace directive. Native 128-frame rendering benchmarks allocate 0 B/0 objects: approximately 0.58/0.93/4.87 µs for mono/stereo/eight channels and 44.6 µs for resampled stereo on the i7-1255U.
- [x] Removed the Phase 0 tone controls from the UI; playback requires a nonempty loaded document. `tone.configure` remains an explicit diagnostic API. Browser and Electron smoke tests now play imported WAV audio, stop and reopen documents; the production browser transport test taps the real worklet graph and verifies distinct +0.5/−0.25 channel samples, not just counter movement.
- [x] The isolated production device-clock test retains the 128-frame (one-quantum) limit. It samples the cursor at its actual DOM update, attaches all timing measurements and runs after parallel functional tests. The full browser suite passes 17 tests: an initial 20-sample cursor check has maximum error 10 frames; three additional isolated runs have maxima 11/12/12 frames. The final full-suite run on the isolated preview port passes all 17 tests with 20 cursor samples at maximum error 14 frames. Every timing run has zero underruns. Earlier React-painted cursor errors of 500–1907 frames motivated direct animation-frame painting; scheduler-delayed observer measurements are not substituted for actual update-time measurements. This is a reproducible acceptance check, not a guarantee under arbitrary OS scheduling stalls.
- [x] Verification: `just ci` passes with 158 frontend tests, both typechecks, formatting/tidy, native/WASM vet and lint, Go race coverage of 99.5% storage/92.0% engine and a production build. One contended rerun hit five 5-second component-test timeouts and one waveform-ready wait failure; all 15 tests in those files then passed serially with runner timeout headroom, and the standard frontend rerun passed all 158 tests without overrides. `just test-go-wasm`, all 17 production browser tests, the Electron imported-document playback/waveform smoke and `just check-deps` pass. The dependency check verifies current tagged algo-dsp v0.7.3, algo-fft v0.8.0, algo-vecmath v0.1.3, algo-approx v0.2.0 and wav v0.1.1.

### Phase 1 acceptance follow-up: Import profiling — ✅ DONE (2026-10-03)

- [x] `just bench-import-profile <absolute-existing-directory>` captures the full ten-minute native import's CPU profile and test binary outside the worktree, then prints the hotspots. The initial native three-iteration run measured 452.065 ms/import, 235144253 B/op and 4437 allocations; channel extraction was 31.3% of sampled CPU, PCM16 decoding 23.3% and upstream `Summary` 20.7%. The final quieter three-iteration run measured 165.414 ms/import, 235146032 B/op and 4439 allocations; extraction accounted for 14.9% of sampled CPU. Host conditions differ, so these profiles locate work rather than prove a fixed wall-time speedup; only the production browser gate verifies browser acceptance.
- [x] `internal/audiobuf/block.go` uses eight-frame, bounded-slice stereo groups in `copyInterleavedChannel`; mono and other channel counts retain their existing copy paths. No sample arithmetic, codec/DSP duplication, unsafe access or ownership change. `interleaved_test.go` compares the original scalar copy in `BenchmarkInterleavedCopy` and checks exact IEEE bits for 1–8 channels at group/cache/block boundaries and short tails. Initial copy-only trials showed approximately 13.3 versus 25.3 µs natively and 80–93 versus 140–382 µs under V8/WASM, with zero allocations; short-run JIT/host variance prevents treating these as a fixed end-to-end speedup.
- [x] `use-document.ts` starts file reading while playback shutdown is pending. `Promise.allSettled` handles early rejections immediately and holds the operation lock until both finish; only then can `doc.open` run. Deferred-promise regressions cover both completion orders, failures, cancellation, serialization, unmount and client replacement. `WaveformView` keeps one full-range channel-0 peak result shared by the overview and fitted first lane, with separate requests when zoomed; component and real-kernel browser tests verify one full-range query, fit reuse and invalidation after reopening an identical document.
- [x] The strengthened `just bench-import-browser` gate includes file reading, document metadata and both channel canvases plus the overview drawn. Test-only probes attach file-read, RPC, document-UI and waveform-tail timings without adding an application diagnostic API or altering the < 1 s limit. Three consecutive isolated Chromium runs on the i7-1255U pass at **524.000/564.160/539.245 ms**, with kernel RPCs 375.975/399.525/368.810 ms, file reads 105.795/123.655/117.275 ms and post-metadata waveform tails 26.215/24.595/30.715 ms.
- [x] Verification: full `just ci` passes (167 frontend tests, native race coverage 99.5% storage/92.0% engine, native/WASM vet and lint, both typechecks, formatting/tidy and production build). Native and V8/WASM storage/kernel regressions pass. All 17 production browser tests pass, including the actual shared peak query and a 20-sample cursor check at maximum error 5 frames with zero underruns; the Electron imported-WAV playback/waveform smoke passes too.

**Preserved performance variance:** the strengthened gate initially failed at 7215.980 ms (metadata ready 6792.220 ms, kernel RPC 6100.620 ms) with host load averages 70.63–81.09 on 12 logical CPUs, 0% idle CPU and about 29 GiB of occupied swap. Another pre-optimization isolated-port run failed at 1241.865 ms (metadata 1192.800 ms, RPC 932.135 ms), and the follow-up baseline failed at 1679.750 ms (metadata 1613.140 ms, RPC 1335.350 ms). A contended optimized run also failed at 2291.100 ms (file read 347.100 ms, RPC 1762.250 ms, document UI 58.150 ms, waveform tail 107.115 ms) with 0% idle CPU. Its native profile measured 3.230 s/import and only 4.48 s of CPU samples over 16.36 s elapsed, so it is not a controlled before/after comparison. Keep these failures alongside Phase 1.3's earlier measurements: the three final browser passes establish the target-laptop acceptance check, not a worst-case guarantee under arbitrary host contention. One attempt collected no import measurement because an unrelated app took port 4173; Playwright now owns its preview lifecycle and accepts `AAE_E2E_PORT`, avoiding silent reuse of another project's server.

---

## ✅ Phase 2: Selection & Editing — COMPLETE (2026-10-03)

**Goal:** Cover the editing basics: select, cut, copy, paste, delete, undo, and markers.

**Acceptance criterion:**
- Every edit is undoable and redoable to an exact match.
- Cut/paste on a 1-hour file completes in < 50 ms, because only block lists change.
- Undo history of 100 steps on a 1-hour file stays under 2× the document's memory.

### Phase 2.1: Selection model — ✅ DONE (2026-10-03)

- [x] `internal/engine/editor.go` owns start/end frame selection and a positive 1–8-channel bitmask. `selection.get/set` and the mirrored Go/TypeScript ABI v5 include a document identity; each successful import creates a new identity and resets to cursor zero/all channels, while failed imports preserve selection and anchors. `TestEditorDocumentIdentityAndReset`, `TestSelectionValidationAtomic` and long-frame/empty-document tests cover stale IDs, invalid masks, fractional/unsafe coordinates and atomic rejection. `use-selection.ts` serializes writes with only the latest pending range, separates preview/committed/acknowledged state and guards client/document replacement, unmount, StrictMode and late initialization; 14 deferred-RPC tests cover cancellation, rejected writes and stale analysis errors.
- [x] `WaveformView` supports click-to-cursor, forward/reverse drag, Shift-click extending the nearest edge (ties move the end), edge dragging across the fixed endpoint and one-sample arrow-key edge adjustments. Grab offsets preserve stationary handles at frame zero/EOF. Matching pointer cancellation/lost capture restores the committed range; import locks and new selection sessions invalidate asynchronous completion before it can seek. Double-click chooses the smallest containing named region, otherwise the adjacent-marker interval or whole file. Channel masks limit highlighted lanes without muting audition playback; mask-only changes do not seek. The 36 waveform component tests cover interactions, subset overlays, snap failures and delayed results after numeric/channel/client/document/busy changes.
- [x] Optional marker/region-edge and displayed-ruler-tick snapping uses coordinate-only nearest-candidate matching within six CSS pixels, with earlier-frame ties. `selection.snap` performs selected-channel zero-crossing searches only in Go, using tagged `algo-dsp v0.7.4`'s new generic `stats/time.NearestZeroCrossing`, implemented, tested and released upstream first. Inclusive radius queries copy at most 16386 float32 frames into one bounded window, including the predecessor needed for a left-boundary crossing; UI radius is additionally limited to approximately 20 ms and 8192 frames. Native/V8-WASM tests cover exact zeros, sign changes, nonfinite values, ties, lookback exclusion, EOF and offsets beyond 2³¹. Failed analysis restores the committed selection with an error instead of silently applying an unsnapped change; no local DSP copy or sample processing in JS.
- [x] `SelectionBar` exposes start/end/length numeric entry in the current sample/second/h:m:s format, All/Left/Right presets and arbitrary channel subsets. `lib/selection.ts` uses exact BigInt decimal arithmetic to round-trip safe frame integers, including `Number.MAX_SAFE_INTEGER` at supported rates. Enter/blur commits valid bounds atomically; Escape cancels, invalid drafts show accessible errors, focused drafts survive external updates, and reopening a document discards old drafts. Empty masks are prevented. The 63 helper/control tests cover precision, malformed/overflowing values, field bounds, formats, drafts and channel controls; App's Home/End now collapse the kernel selection at the seek target while button Space activation and global zoom shortcuts remain intact.
- [x] Minimal document-scoped named anchors initially made marker snapping and region double-click selection usable: `timeline.get`, `markers.add`, `regions.add`, ruler targets and Add marker/Add region controls. IDs are shared per-document, names are trimmed/UTF-8 validated with a 256-byte cap, and snapshots expose non-null independent arrays with a 4096-anchor cap. `TestTimelineAnchorsAndSnapshots` checks defaults, ownership and atomic validation. Phase 2.4 subsequently delivered full marker management, colors, document metadata persistence, edit shifting, list/export and WAV cue round-trip.
- [x] Verification: full `just ci` passes with 265 frontend tests, both typechecks, formatting/tidy, native/WASM vet and lint, native race coverage of 99.5% storage/93.3% engine and the production build. `just test-go-wasm` passes all kernel/storage/bridge tests. All 22 production browser tests pass, including five new real-kernel selection tests and the unchanged audible-cursor gate (20 samples, maximum error 8 frames, zero underruns). Electron's imported-WAV smoke additionally verifies numeric selection, right-channel targeting and named region creation over isolated `app://`. `just check-deps` verifies the current tagged sibling dependencies, including algo-dsp v0.7.4. No Phase 2.1 items were deferred.
- [x] The unchanged full ten-minute browser import regression gate also passes after selection integration at 774.535 ms, including both channel waveforms and the overview drawn (file read 133.715 ms, kernel RPC 578.400 ms, waveform tail 32.775 ms). This is one isolated measurement, not a worst-case bound; Phase 1's preserved timing variance remains applicable.

### Phase 2.2: Edit operations — ✅ DONE (2026-10-03)

- [x] `internal/ops/operation.go` adopts the value-operation design inspected in `mfw/pkg/ops`, with a platform-independent `Operation.Apply(Document) (Document, error)` interface. Immutable results share untouched blocks and preserve document rate/metadata; failed operations return the unchanged input. DSP primitives remain in tagged sibling libraries, not copied from mfw.
  - [x] Delete, clipboard Copy, Cut (copy plus delete staged atomically by the engine), Paste insert/replace/mix, and Crop time. Insert ignores the selection end, Replace substitutes its range, and Mix adds the entire clipboard at the start without clipping or shifting, extending at EOF when necessary. Crop applies time to all channels, explicitly labeled in the UI. Bitwise float goldens, source-immutability checks, export/reimport tests and real-kernel browser exports cover the results.
  - [x] Insert silence at the start using an exact positive frame count; Duplicate inserts immediately after the end without changing the clipboard; Swap exchanges exactly two selected channels within the range, or the whole file for a collapsed range; Mute preserves duration. Selected-channel ripple edits keep unselected sample positions unchanged, padding shorter channels only at EOF. Tests cover arbitrary eight-channel masks, short/fractional block boundaries, special IEEE values, empty documents and coordinates beyond 2³¹.
- [x] `audiobuf.Window` retains only touched original blocks with bounded first/last edges: Copy allocates block lists but no samples or peaks, even for unaligned boundaries. Selected source channels are packed in ascending order. `ops.Clipboard` survives subsequent opens, uses opaque versions and leaves its original contents intact after conversion. `CountMemoryWithWindows` deduplicates its backing blocks against the current document. Shared silence blocks avoid duration-sized zero buffers. Window ownership/read/materialization and one-hour cut/paste storage tests verify sharing; system clipboard WAV exchange remains a later nicety, not a deferred Phase 2.2 item.
- [x] Additive, mirrored ABI v5 methods `edit.state`, `edit.prepare-paste` and `edit.apply` carry explicit document IDs, selections and clipboard versions. Every successful audio mutation publishes a fresh document identity and stops kernel transport; Copy and empty no-op edits retain identity/transport. Fallible work is staged before publication. This phase initially clamped marker coordinates and dropped collapsed regions; Phase 2.4 replaced that temporary behavior with document-owned, edit-aware annotation transforms.
- [x] Mismatched sample rates or selected channel counts require explicit confirmation in the accessible native conversion dialog. `clipboard_convert.go` uses tagged `algo-dsp v0.7.4` sinc resampling and `algo-vecmath v0.1.3` block sum/scale primitives: expansion repeats channels cyclically, reduction averages cyclically folded contributors. Predicted duration is `ceil(sourceFrames × targetRate / sourceRate)` with trimmed delay and flushed tails. Conversion bounds newly materialized sample output to 512 MiB and filter workspace to 64 MiB, without imposing that output cap on shared same-format structural pastes. Mix likewise checks its selected-channel output against a 512 MiB budget before allocating; tests cover exact-limit/overflow arithmetic, mono broadcast, shared >512 MiB insert/replace, unchanged engine state on rejection and real-browser safe rejection. Conversion tests compare 24 duration/tail cases with an independent tagged sinc reference, check all 64 channel routes, DC, high-ratio rates, stale versions, explicit confirmation and atomic errors.
- [x] `use-edit.ts`, `EditToolbar`, the Edit menu and Ctrl/Cmd+X/C/V wire every operation to the kernel. Edit preparation, confirmation, stop/apply and file operations share one lock; stale/unmounted replies and cancellation cannot overwrite a newer document or release its lock. Copy leaves playback running. Unfinished pointer/zero-snap previews cannot be captured by commands; exact silence input rejects fractions/overflow. Edited views seed selection/anchors from the returned snapshot with client and document ownership, then refresh guarded server state. Hook/control/selection tests and browser/Electron regressions cover the workflows. Undo/redo, dirty tracking and the command registry remain their separate unchecked subphases below.
- [x] Verification: full `just ci` passes with 336 frontend tests across 24 files, both TypeScript checks, formatting/tidy, Go lint/native race tests/WASM vet and the production build. Race coverage is 99.2% storage, 92.9% engine and 87.8% operations. `just test-go-wasm` passes every kernel/storage/operations/bridge package. All 29 production browser tests pass, including seven edit tests checking actual exported sample payloads, conversion cancellation, playback-preserving Copy, shortcuts, unfinished previews, empty-file paste and oversized Mix rejection. The unchanged audible-cursor gate has 20 samples, at most 11 frames of error and zero underruns. Electron's isolated `app://` smoke additionally cuts and pastes imported audio while verifying selection/region UI. `just check-deps` confirms current tagged sibling dependencies. No Phase 2.2 items were deferred.
- [x] `BenchmarkCutPasteHourStereo` meets the <50 ms structural gate: final ten-iteration runs are 0.635 ms native and 1.760 ms actual Node/V8 WASM, about 1.48 MB and 82 allocations per operation. Earlier runs were 0.859/2.722 ms. The fixture has full 172,800,000-frame 48 kHz stereo block lists, with reused immutable sample/peak backing blocks to bound fixture memory; the timed operation copies an unaligned clipboard, cuts [48,000,017,96,000,031), and pastes it back, traversing normal full-duration block lists. Tests prove Copy adds zero sample/peak bytes and retained source/cut/restored snapshots add at most 12 boundary blocks. Tone and 1/2/8-channel document rendering remain at zero B/op and zero allocations. This does not claim the 100-history-snapshot acceptance gate before Phase 2.3 exists.
- [x] The unchanged isolated full ten-minute browser import gate also passes at 527.290 ms, including the drawn channel waveforms and overview (file read 115.335 ms, kernel RPC 357.845 ms, waveform tail 26.815 ms). This is one measurement, not a worst-case bound; Phase 1's preserved environmental timing variance remains applicable.

### Phase 2.3: Undo/redo history — ✅ DONE (2026-10-03)

- [x] `internal/history/history.go` retains labeled before/after immutable snapshots with opaque state IDs, copy-on-write staging, branch truncation and atomic count/unique-block byte limits. The application keeps at most 100 commands plus their base state, with a sample/peak budget of `max(512 MiB, 2 × opened-document storage)`. Oldest undo states are evicted first; the immediate current undo pair is preserved, and an edit that cannot retain that pair is rejected without changing audio, clipboard, controls, transport or history. Evicted snapshots are removed from hidden backing-array slots so Go GC can release their blocks. Core tests cover navigation, branching, cloned-list ownership, budget/count eviction, configurable limits and atomic errors; block-list, metadata and runtime overhead are explicitly outside this audio-storage metric.
- [x] `internal/engine/history.go` snapshots the shared document and independent editor controls. Audio edits capture their explicit RPC selection before mutation; navigation captures live controls before leaving a state. Undo/redo/jump publish a fresh document identity and stop transport, without restoring or replacing the clipboard; jumping to the current row is a playback-preserving no-op. Successful open resets history clean, while failed open preserves it. Copy, empty no-ops and selection changes do not add history steps. Phase 2.4 moved canonical anchors/identity sequencing into document metadata and made annotation changes undoable/dirty, superseding the initial anchor-only exception. Native bitwise goldens cover every audio operation, including special IEEE values, with selection/anchor and clipboard invariants.
- [x] Mirrored Go/TypeScript ABI v6 adds `edit.undo`, `edit.redo`, `history.list`, `history.jump` and `doc.mark-saved`; `EditResult` includes its authoritative history snapshot. `doc.memory` now deduplicates all retained history documents and clipboard backing blocks. `use-history.ts` guards client/document ownership, stale initialization, unmount and overlapping navigation; it shares the file/edit operation lock. The expandable `HistoryPanel` exposes navigation, current/saved/redo states and retained storage. Edit-menu controls and Ctrl/Cmd+Z, Shift+Z and Y shortcuts respect busy state and text-field undo; summary Space activation does not start playback. The centralized command registry remains Phase 2.5.
- [x] Dirty state compares the current opaque state ID with the last acknowledged save point, without retaining extra saved audio. `use-document.ts` captures the state under the shared lock, exports, awaits the destination write, then acknowledges that exact document/state through `doc.mark-saved`. Failed/cancelled/stale writes and export alone never mark clean; undo/redo back to the saved state does, while branching away from or evicting it remains dirty. Save locking lasts through the acknowledgement, with lifecycle regression tests. History summary and window-title asterisk show unsaved document changes. File System Access waits for write/close; browser download fallback can verify only browser handoff, not disk completion/cancellation. Phase 2.4 subsequently added anchor persistence/dirty tracking; unsaved-close prompts remain Phase 9.
- [x] `TestHundredStepsHourMemoryAndExactUndoRedo` retains all 100 commands/101 states on full 172,800,000-frame 48 kHz stereo block lists after 100 unaligned one-frame mutes. All 100 undo and redo transitions restore exact immutable snapshots/IDs and bitwise touched samples/neighbors; every distinct source block is checked unchanged. The bounded fixture uses 128 distinct full blocks plus two tails, reused across remaining positions, not a fully distinct 1.4 GiB capture. Deduplicated samples plus cached peaks grow from 34,496,672 to 61,157,472 bytes (1.772851×), strictly below 2×, without count or byte eviction. An engine-level hour test separately verifies the real RPC mutation/navigation path and shared zero blocks.
- [x] Ten-iteration cut/paste benchmarks meet the <50 ms structural gate with 100 retained commands. `BenchmarkEngineCutPasteHourHistory100` is 7.503 ms native / 28.927 ms actual Node/V8 WASM, roughly 778 kB and 112–113 allocations per pair; it includes edit staging, history retention/pruning and result snapshots on full-duration stereo lists, after shared whole-channel swaps. The stronger `BenchmarkHistoryCutPasteHourStereoAtCapacity`, on the 128-distinct-block fixture after 100 unaligned edits, includes clipboard preparation, both operations and both bounded history pushes: isolated native 12.061 ms / WASM 47.783 ms, 1,667,808 B and 153 allocations per pair. Concurrent checks gave 30.569/66.922 ms before isolation; these are host-sensitive measurements, not worst-case latency guarantees. `just bench-wasm` now includes `internal/history`.
- [x] Verification: full `just ci` passes with 369 frontend tests across 26 files, both TypeScript checks, formatting/tidy, Go lint/native race tests/WASM vet and the production build. Race coverage is 99.2% storage, 92.2% engine, 100% history and 87.8% operations. `just test-go-wasm` passes every kernel/storage/operations/history/bridge package. All 44 production browser tests pass, including 15 history regressions checking actual exported audio, restored selections/anchors, unchanged clipboard, jumps/branches, save success/failure/cancel, failed/repeated opens, converted-paste redo and undo/redo during playback. The unchanged audible-cursor gate has 20 samples, at most 11 frames of error and zero underruns. Electron's isolated `app://` smoke additionally undoes/redoes imported-WAV edits. Native and actual WASM tone/1/2/8-channel document renders remain at zero B/op and zero allocations. `just check-deps` confirms current tagged sibling dependencies. No Phase 2.3 items were deferred.
- [x] The unchanged isolated full ten-minute browser import gate passes with history initialization at 529.485 ms, including the drawn channel waveforms and overview (file read 91.935 ms, kernel RPC 366.810 ms, waveform tail 38.305 ms). This is one measurement, not a worst-case bound; the documented environmental timing variance remains applicable. The production JS chunk now measures 502.30 kB (160.52 kB gzip), triggering Vite's nonfatal default 500 kB warning; it is recorded rather than hidden by increasing the limit.

### Phase 2.4: Markers & regions — ✅ DONE (2026-10-03)

- [x] `internal/audiobuf/timeline.go` stores typed markers/regions, names, canonical `#rrggbb` colors and a shared identity allocator in immutable document metadata. `NewDocument`, `Metadata` and fallible `WithMetadata` defensively clone and validate annotations; `Slice` intersects/rebases them. IDs are positive uint32 values, with an exhausted allocator sentinel; names are trimmed UTF-8 without NUL, capped at 256 bytes, and combined anchors at 4096. Storage ownership/validation tests cover aliases, invalid IDs/names/colors, long exact offsets, EOF and exhausted identities. These document-owned annotations replace the temporary editor-only anchors described in Phases 2.1–2.3.
- [x] `internal/ops/operation.go` transforms annotations before validating shortened documents. All-channel deletion drops points in `[start,end)` and collapses/shrinks region remnants; insertion shifts points/region starts at the insertion boundary, while region ends there stay left. Replacement composes deletion/insertion; crop intersects regions and keeps closed-boundary points, including new EOF. Subset-channel ripple edits preserve global coordinates because unselected sample positions do not move. Mute, swap and Mix preserve coordinates; Copy/Paste and Duplicate do not clone annotations. `audiobuf/timeline_test.go` and `ops/timeline_test.go` check exact endpoint rules, replacement, all-channel and 2/8-channel subset edits, failures and long offsets.
- [x] Mirrored Go/TypeScript ABI v7 adds colors, `markers.update/remove`, `regions.update/remove`, authoritative metadata mutation/history results and binary `timeline.export`. `internal/engine/timeline.go` stages undoable add/update/remove transactions with their explicit committed selection; unchanged updates are history/dirty no-ops. Metadata mutations keep the audio document identity, transport, samples, peaks and clipboard unchanged. Undo/redo restores annotations and allocator with the document and stops transport as before. Exact save-state acknowledgements remain mandatory even when metadata retained the same document ID. Engine regressions cover playback/identity/storage invariants, atomic validation, metadata undo/redo, save points and read-only exports; the original Phase 2.3 anchor-only history exception is superseded.
- [x] `TimelinePanel`, `WaveformView` and `use-selection.ts` provide colored ruler targets and an expandable management list with jump, rename/recolor/reposition, delete and CSV/label export. Exact-time and UTF-8 name validation retain invalid drafts for correction. Mutations serialize through the shared file/edit/history lock and carry committed selection, not pointer/snap previews; lifecycle and revision guards reject stale clients/documents/replies. Metadata-only results update history without replacing document info, resetting zoom, requesting new peaks or stopping playback. Hook/panel/waveform tests cover these behaviors and previews; production browser and Electron tests verify actual colored management and undo/redo.
- [x] `internal/engine/timeline_export.go` sorts annotations by start frame/ID and emits quoted CSV with kind, ID, name, color, exact frame bounds and rational seconds, or Audacity-style three-column label text. Labels reject names containing tabs/CR/LF instead of flattening them; CSV preserves them. Sidecars transfer UTF-8 `ArrayBuffer`s through `kernel-call.ts`, use format-specific save-picker filters in `use-document.ts`/`file-access.ts`, and never acknowledge the WAV save point. Kernel, transfer-detachment, picker, shared-lock/cancel/failure/stale-session and browser-download tests cover the complete path.
- [x] Released upstream `github.com/cwbudde/wav v0.1.2` at commit `1379091`, then updated `packages/kernel/go.mod`/`go.sum`. Its additive cue/adtl serializers and independent bounded decoders support `labl`/`note`/`ltxt`, append multiple adtl lists, preserve unknown subchunks and fix nested INFO/adtl and outer raw-chunk padding. Count/size/truncation bounds and missing-final-padding errors have native/race and actual-WASM regressions. The guarded release passed remote/clean-default-branch/current-dependency checks and exported-API compatibility; no incompatible APIs, pseudo-versions or app replacement pin. New-code lint has zero findings; upstream full lint retains 148 pre-existing findings (159 at its clean baseline), with no config suppression or unrelated sibling-worktree changes.
- [x] `internal/engine/wav_timeline.go`/`wav.go` import and export standard WAV `cue` points, `LIST/adtl` names and region lengths through the tagged codec. An application-owned `aeMD` extension carries only colors and the allocator, not a substitute for standard annotations. Recognized metadata is pre-indexed and capped at 2 MiB without scanning PCM through the metadata decoder; names/references/duplicates/frame bounds validate before publication. Foreign cue zero remaps to a free positive ID, positive uint32 IDs remain exact, and missing colors use `#a78bfa`. Export counts all headers/padding and rejects annotation positions/lengths beyond uint32 rather than truncating. Independent wire goldens cover pre/post-audio ordering, multiple lists, odd/Unicode names, zero/maximum IDs, allocator-only files, malformed/budget rejection without document/history/playback loss and bitwise special-IEEE audio preservation. Browser Save/reopen verifies names, colors, IDs, exact audio and clean history; general metadata preservation remains Phase 6.
- [x] Verification: full `just ci` passes with 418 frontend tests across 27 files, both typechecks, formatting/tidy, Go lint/native race tests/WASM vet and production build. Race coverage is 98.0% storage, 90.7% engine, 100% history and 87.1% operations. `just test-go-wasm` passes all kernel packages; `just fuzz-wav 10s` completes 616142 executions without failure. All 46 production browser tests and Electron pass; the final audible-cursor gate has 20 samples, nine frames maximum error and zero underruns (earlier run: 12 frames). `just check-deps` confirms current tagged siblings. No Phase 2.4 items were deferred.
- [x] Preserved performance gates: final isolated ten-minute browser import is 527.980 ms (file read 92.685 ms, kernel RPC 376.940 ms, drawn-waveform tail 34.330 ms); an earlier run passed at 928.055 ms. Engine cut/paste with 100 retained commands is 6.340 ms native / 27.527 ms actual WASM over ten iterations. The stronger at-capacity snapshot benchmark is 12.247 ms native and varies across WASM runs: 50.189/50.333/48.867/47.350 ms, two slightly over 50 ms; these measurements are not a worst-case guarantee. The existing 100-step exact undo/redo and <2× deduplicated audio-memory test passes unchanged. Tone and 1/2/8-channel document renders remain zero B/op and zero allocations. The JS chunk is 510.49 kB (162.53 kB gzip); Vite's existing nonfatal 500 kB warning remains visible.

### Phase 2.5: Keyboard & commands — ✅ DONE (2026-10-03)

- [x] `lib/commands.ts` owns typed IDs, labels, menu order, structured shortcuts and enabled predicates for all available file/edit/view/transport/marker actions and planned disabled processing/effects. `use-commands.ts` supplies resolved metadata to the menubar and palette, dispatches one global keyboard listener and rechecks current document/selection/clipboard/busy state before every execution. Predicates validate bounded safe frame/channel metadata and exact paste/silence growth without processing samples in JS. `App.tsx` binds existing actions by ID; `WaveformView` exposes guarded select-all/marker/region handles, and the controlled silence draft is shared with `EditToolbar`. Readiness notification after handle publication prevents an unchanged-coordinate pointer commit from leaving menus disabled.
- [x] `CommandPalette` is a native modal opened with Ctrl/Cmd+K or Help → Command palette. Accessible combobox/listbox search matches labels, menus and shortcuts; disabled/planned entries stay discoverable, enabled navigation wraps with arrows and supports Home/End, Enter dispatches once, and Escape/cancel/backdrop dismiss. Closing restores focus synchronously before invoking file pickers or another dialog; controlled-close restoration happens after React's focus commit. Tests cover IME, empty/disabled results, live props, StrictMode, focus handoff and detached openers.
- [x] Platform detection prioritizes Electron's `darwin` bridge, then the browser's Mac platform. Windows/Linux use Ctrl, macOS uses Cmd; exact modifiers reject Alt, collisions and unrelated Shift combinations. Redo is Ctrl/Cmd+Shift+Z, with Ctrl+Y on Windows/Linux only. File/palette shortcuts work in text fields, while edit/navigation shortcuts remain native there; Space preserves button/link/summary activation. Dialogs and open menus retain keyboard handling, closed Base UI animation popups do not block editor commands, and only zoom repeats. Select-all and Delete join existing transport/edit/zoom shortcuts. The shortcut editor remains the already-planned later feature; no additional Phase 2.5 items were deferred.
- [x] File → Export WAV and Ctrl/Cmd+Shift+E now call `useDocument.exportAudio`, not Save. Export writes the original format under the shared operation lock without `history.list`, `doc.mark-saved`, save-point publication, playback shutdown or document replacement. Cancellation/kernel/write failures preserve dirty state; Save alone acknowledges a successfully written history state. Unit and actual-kernel browser regressions cover the distinction, including empty WAV export.
- [x] Verification: full `just ci` passes with 489 frontend tests across 31 files, both typechecks, formatting/tidy, Go lint/native race tests/WASM vet and the production build. `just test-go-wasm` passes every kernel package. All 51 production browser tests pass, including five command tests checking actual audio, menu dispatch, native text selection, exact silence insertion, pointer readiness, focus and macOS bindings. The unchanged audible-cursor gate has 20 samples, nine frames maximum error and zero underruns (earlier run: 15 frames). The existing Phase 2 structural/history/memory regressions pass unchanged; Phase 2.4's documented stronger WASM benchmark variance remains applicable. The JS chunk is 523.12 kB (166.15 kB gzip); the existing nonfatal 500 kB warning is preserved.
- [x] Electron's isolated `app://` smoke passes with an additional keyboard palette search/dispatch that fits the actual document viewport. `just check-deps` confirms all sibling dependencies remain current tagged releases; this frontend-only phase changes neither the kernel ABI nor DSP dependencies.
- [x] The unchanged full ten-minute browser import gate passes at 652.335 ms, including both channel canvases and the overview drawn (file read 120.505 ms, kernel RPC 450.835 ms, waveform tail 43.095 ms). This isolated measurement is not a worst-case bound; the previously recorded host-contention variance remains applicable.

---

## Phase 3: Basic Processing

**Goal:** The everyday destructive processes, applied to the selection (or the whole file), each undoable.

**Acceptance criterion:**
- Every process has a Go golden test against a reference vector.
- Processing a 10-minute stereo file takes < 1 s.
- A long process shows progress and can be cancelled without corrupting the document.

### Phase 3.1: Processing infrastructure — ✅ DONE (2026-10-03)

- [x] `internal/process` defines `Process.NewChannel` and stateful `Processor.ProcessBlock`, with a `Builder` that streams selected channels in ≤65536-frame steps through private float32 → float64 → tagged upstream DSP → float32 scratch. It builds immutable output blocks, shares unchanged channels/full boundary blocks, preserves metadata and supports exact zero-gain storage identity. Factory/processor failures and cancellation discard unpublished output. Tests cover stateful biquad chunk parity, 1–8-channel masks, fractional boundaries, metadata ownership, special samples, offsets beyond 2³¹, early validation and the 512 MiB selected-output ceiling. `MemoryDocument` accounts for partial/private output without double-counting shared history storage.
- [x] Mirrored ABI v8 adds `process.start/step/cancel/commit`, job-scoped finite peak/nonfinite telemetry and optional `transport.play.previewJobId`. `internal/engine/process.go` captures document/history identities and the original editor selection, protects active jobs against competing mutations, retains cancellation tombstones for terminal replies and stages one atomic undoable commit. Failed history retention/identity exhaustion leave the original document and ready candidate unchanged; zero dB changes neither history, document identity nor cursor. Engine tests cover source validation, locks, partial memory deduplication and exact undo/redo.
- [x] `kernel/process-runner.ts` drives bounded Go steps and `task-yield.ts` yields a real MessageChannel task between chunks, allowing immediate cancellation RPCs. Worker progress contains control metadata only. `KernelClient.runProcess` validates job identity and monotonic progress; a 15-second inactivity watchdog and all processing-RPC timeouts terminate the worker before releasing ownership, fencing late commits. `useProcess` holds the shared document operation lock throughout the modal/candidate lifecycle, and `ProcessDialog` shows progress, Preview/Stop/Apply/Cancel and restores focus. Tests cover stale progress, inactivity, cancellation before start/while running, commit-versus-Cancel, unmount, replacement clients and rejected old commits releasing their fences.
- [x] Private candidate playback uses the existing producer/SAB/worklet path, including resampling, without replacing the committed document or save point. `AudioEngine.prepare` unlocks the context under the Preview gesture; preview loops the processed selection and Stop retains its candidate. Cancel drops candidate transport references. Fatal-worker disposal still disconnects/closes browser resources. Actual-worklet browser tests prove changed output, unchanged committed export/history, preview reuse and ordinary original playback after Cancel; Electron's isolated `app://` smoke exercises Preview/Cancel. The worklet remains copy-only and the kernel remains off the audio thread.
- [x] Amplify is the first real processor exercising the infrastructure; remaining Phase 3 processes stay pending. Checked-in IEEE gain vectors in `gain_golden_test.go` are independent of the production adapter and cover half/double, ±6 dB, −120/+60 dB and zero-gain special-bit identity; upstream parity and rounding/overflow/finite-compaction tests remain additional checks. `bench-process`, `bench-process-wasm` and opt-in `bench-process-browser` reproduce the ten-minute 48 kHz stereo workload. On the i7-1255U, isolated native core/engine measurements are 349.655/369.434 ms and WASM 822.269/843.132 ms. The full browser Apply→yielded processing→atomic commit→both lanes and overview drawn gate passes at 809.240 ms (769.390 ms run, 2.665 ms commit, 440 progress events, 9.845 ms maximum progress gap). These are isolated measurements, not worst-case guarantees; hardware gates remain outside shared-runner CI. The unchanged full browser import gate passes at 560.010 ms.
- [x] Verification: `just ci` passes with 579 frontend tests across 35 files, Go race tests (92.9% processing, 91.0% engine coverage), native/JS-WASM lint and vet, both typechecks, formatting, tidy and the production build. `just test-go-wasm` passes all kernel packages including the independent static goldens. All 55 production browser tests pass; the audible-cursor gate retains 20 samples, 11 frames maximum error and zero underruns (earlier run: nine frames). Electron preview/cancellation passes under the existing isolation/CSP. Native tone, 1/2/8-channel transport and resampled transport benchmarks retain 0 B/op and 0 allocs/op. A second isolated browser processing run passes at 729.860 ms, with 440 progress events and a 7.170 ms maximum gap. No DSP dependency or upstream release change is needed for this adapter. The existing nonfatal bundle warning remains: JS 534.88 kB, 169.50 kB gzip.

### Phase 3.2: Processes

- [x] Amplify / gain: `internal/process.Gain` uses tagged `algo-dsp/core.DBToLinear` and `algo-vecmath.ScaleBlockInPlace`; Process → Amplify accepts −120 to +60 dB for the selected range/channels or the whole file from a cursor. Predicted float32-rounded finite peak and nonfinite flags require a separate Apply anyway acknowledgement before committing an unsafe result; gain never clamps samples. Delivered as Phase 3.1's working processor, with static native/WASM goldens, dialog/hook lifecycle tests and actual-kernel browser tests for subset-channel output, clipping confirmation, 0 dB identity and exact undo/redo.
- [ ] Normalize: peak (dBFS) and loudness (LUFS via `algo-dsp/measure/loudness`)
  - [x] **Upstream (algo-dsp):** released additive `measure/loudness.IntegratedAnalyzer`, `PlanNormalization` and fresh-output `NormalizeLoudness` as **v0.7.5** (`e8f67b9`), then bumped `packages/kernel/go.mod` / `go.sum` to that tag. Published BS.1770-5 K-weighting, complete 400 ms / nominal 100 ms gating with accumulated sample-rounded endpoints, explicit channel weights, bounded planar float32/float64 blocks, incremental finalization and reusable Reset are covered by streamed EBU integrated cases 1–6, an independent DF1/gating golden, rate/chunk/EOF/ownership/safety tests and zero-allocation assertions. Existing approximate `Meter` behavior is unchanged; neither it nor this integrated-only analyzer claims LRA or true-peak support. The helper applies an input-derived linked gain, not an unconditional post-gain LUFS guarantee when absolute-gate membership changes. The release guard verified compatibility with v0.7.4 and current siblings.
    - [x] `internal/process/loudness_dependency_test.go` validates the tagged API against an independent dyadic float32 loudness/gain/output golden, irregular chunks, linked fresh output, source preservation and below-gate errors, natively and under actual V8/WASM. Editor `just ci` passes with 579 frontend tests, Go race tests, lint/native and WASM vet, tidy/format checks and production build; all kernel WASM tests, current sibling-tag checks, 55 production browser regressions and the isolated Electron smoke pass. Device-clock regression: 20 samples, maximum error 7 frames, zero underruns.
    - [ ] **Normalize integration / performance remains pending:** upstream analyzer-only ten-minute 48 kHz stereo benchmarks (constructor/fixture setup excluded; Reset and finalization included) measure 0.45–0.56 s native and 1.25–1.30 s Node/V8 WASM, with 0 B/op and 0 allocs/op. These do not satisfy or replace the full editor's < 1 s processing acceptance gate. Add the peak/LUFS process workflow, cancellation/preview/undo/UI goldens and isolated end-to-end browser timing before checking the Normalize item; no task is deferred as impossible.
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

- [x] WAV `cue`/`LIST adtl` ↔ document markers and regions: delivered in Phase 2.4 through tagged `wav v0.1.2`, with standard names/positions/lengths and an additional color/allocator extension.
- [ ] General metadata preservation/editor mapping: WAV LIST/INFO, BWF `bext`, adtl notes/locale/unknown chunks, ID3 for MP3 and Vorbis comments for FLAC
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
