# Implementation Plan: algo-audio-editor

> **Architecture Summary:**
>
> - **Kernel:** Go compiled to WebAssembly (`packages/kernel`). It owns everything that touches audio: the document model, edit history, DSP, codecs, peak data and playback rendering. Its DSP comes from the `github.com/cwbudde/algo-*` family (mainly `algo-dsp` and `wav`). The same engine is compiled natively for the `aae` CLI and the `aae-mcp` server.
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
> - **ABI:** `AAEKernel.call(method, json, data?) → json` for control and optional binary input, `AAEKernel.takeData()` for the preceding call's binary output, `AAEKernel.render(u8, frames, positions?)` for audio and optional int64 document-position tags, and `AAEKernel.copyMeters(u8)` for the reusable binary output-meter snapshot. The current ABI version is **18** on both sides. Methods and payloads are defined in `packages/kernel/internal/protocol` and mirrored by hand in `packages/protocol`. Bulk data (audio, peaks, files, spectra, pitch records, RGBA tiles) crosses as transferable `ArrayBuffer`s or through the SAB, never as JSON arrays.
> - **Cross-origin isolation** (needed for SharedArrayBuffer) comes from COOP/COEP headers in Vite dev/preview, `coi-serviceworker.js` on GitHub Pages and the `app://` protocol handler in Electron.

**Product shape:** a waveform editor first, in the spirit of ocenaudio, Sound Forge or Audition's waveform view. Multitrack (Phase 26) builds on the same block-based document model.

**How to read this plan:** Phases 0–15 are complete for their stated scope; their summaries describe what exists today. Every unfinished item lives in Phases 16–28. Feature guides live in [`docs/`](docs/); dated measurements and validation scope live in [`docs/benchmarks/`](docs/benchmarks/README.md). The [historical roadmap at `9de516f`](https://github.com/cwbudde/algo-audio-editor/blob/9de516f/PLAN.md) keeps the full implementation narrative. Testing strategy is in [docs/testing.md](docs/testing.md); release rules are in [docs/releasing.md](docs/releasing.md).

---

## Completed

| Phase | What exists | Guide | Originally |
| --- | --- | --- | --- |
| 0 Scaffolding | Bun/Go monorepo driven by `just`; mirrored protocol; Worker → SAB → copy-only AudioWorklet playback in browser and sandboxed Electron; CI, Pages and dependency-drift workflows. | [README](README.md#architecture) | 0 |
| 1 Document model & playback | Immutable 65,536-frame blocks shared across snapshots, cached peak pyramids, WAV I/O, waveform zoom/scroll, source-position-tagged transport. | [README](README.md) | 1 |
| 2 Selection & editing | Exact numeric/pointer/channel selection with snapping; cut/copy/paste/mix, crop, silence, duplicate, swap, mute; exact undo/redo/branching with save points; markers/regions with WAV cue round trip and CSV/label export; shared command registry, shortcuts and palette. | [README](README.md#editing-audio) | 2 |
| 3 Processing & export | Cancellable private-candidate jobs with Preview/Apply and one undo entry: gain, peak/LUFS normalization, fades/crossfades, reverse, invert, DC removal, channel conversion/extraction, three-quality resampling, generators. WAV export (PCM8–32, float32/64) with seeded dither and noise shaping. | [README](README.md#processing-audio) | 3 |
| 4 Effects | All 51 upstream effects with presets, bounded racks, convolution IRs, latency compensation; shared 128-frame preview/offline path; knob/EQ/dynamics editors; persisted presets. | [README](README.md#effects) | 4 |
| 5 Analysis & metering | Allocation-free output meters (loudness, LRA, true peak, stereo/goniometer); selection/live spectra; progressive spectrogram tiles; statistics; resumable YIN pitch; clipping markers. | [README](README.md#analysis-and-metering) | 5 |
| 6 Codecs & WAV metadata | Go WAV/FLAC/AIFF/MP3 import (gapless MP3); browser Vorbis/Opus/AAC decode; WAV/FLAC/AIFF export plus WebCodecs Opus/M4A; editable WAV INFO with BWF/opaque data retained. | [codecs](docs/codecs.md) | 6 |
| 7 Editor clarity | Compact responsive shell, About diagnostics, sample-level waveform drawing (dots with linear/hold connections). | — | U |
| 8 Restoration | Spectral rectangle/lasso attenuate/remove/heal, profile-based noise reduction, click/pop repair, declipping, WSOLA time stretch, hum notches. | [restoration](docs/restoration.md) | 8 |
| 9 Desktop integration | Native menus/dialogs, scoped file capabilities, atomic writes, audio file associations, single instance, recent documents, window state, guarded close; three-OS packaging, guarded updater flow, signing-gated release workflow; generated app icons. | [desktop](docs/desktop.md) | 9 |
| 10 Batch & automation | Version 1 operation chains, macro recording/replay, isolated per-file UI batches, native `aae` CLI; UI and CLI batch output is byte-identical. | [automation & MCP](docs/mcp.md) | 12 |
| 11 Web deployment | CI-gated GitHub Pages deployment with scoped isolation worker, hashed assets, size budgets, live post-deploy/daily smoke. | [web deployment](docs/web-deployment.md) | 13 |
| 12 MCP foundation | Official-SDK stdio `aae-mcp` with 18 tools, isolated sessions, summary/waveform PNG/binary peak resources, prompts, dry runs and write-root permissions; output matches the CLI and UI. | [automation & MCP](docs/mcp.md) | 14 |
| 13 Review remediation | From the [2026-10-04 review](docs/REVIEW-2026-10-04.md): truthful CI with pinned actions, timeouts and native + js/wasm lint (R.1); kernel robustness, 3 GiB storage budget, fuzzing (R.2); MP3/PCM8/BS.1770 correctness (R.3); resampling/mixing moved upstream (R.4); registered method dispatch, typed names, strict decoding, bounded analysis, incremental history accounting, one-hour FLAC (R.5); frontend lifecycle races (R.6); module split, lazy chunks, optimized WASM and budgets (R.7); keyboard-accessible waveform and selection (R.8); Electron fuses, permission handlers and navigation guards (R.9); roadmap/evidence audit and process docs (R.10). | [benchmarks](docs/benchmarks/README.md) | R.1–R.10 |
| 14 License inventory & notices | Go/npm/Electron inventory collectors, reviewed `docs/licenses/dependencies.json`, generated bundled third-party notices shown in About, `just check-licenses` freshness gate and `just check-license-policy` release gate; system fonts and MIT Heroicons replace OFL/ISC assets; isolated MIT FLAC evaluation and local remediation patches; Go math reach diagnostics. | [licenses](docs/licenses/README.md) | 23 (part) |
| 15 Visual design | App-icon palette shared by DOM and canvas, adaptive waveform lanes, vertical waveform zoom (1×–64×), frequency rulers and spectrogram readouts, analysis dock, restyled dialogs and panels. | [visual design](docs/visual-design.md) | 24 (part) |

---

## Open phases

Original phase numbers are noted per phase; dated reports in `docs/benchmarks/` and older docs use them.

### Phase 16: Processing & Playback Performance Acceptance

*Originally Phase 15.* **Acceptance:** processing a ten-minute stereo file takes <1 s for every process; spectrogram rendering of a ten-minute file never blocks playback or drops samples.

- [ ] Pass the unchanged <1 s gate in `process-benchmark.spec.ts` (32 serial ten-minute operations including Apply, output verification, commit and painted waveforms; extraction includes transfer/import/paint) without Preview/prepared candidates or reduced quality. Last full sweep: 17 pass / 15 timing failures. [Sweeps and reproduction](docs/benchmarks/processing-2026-10-03.md).
- [ ] Profile and explain the historical `spectrogram-playback.spec.ts` underruns (Phase 8 and its baseline failed; Phase 5 and R.5 passed), then rerun without relaxing timing or underrun limits. [Runs](docs/benchmarks/spectrogram-playback-2026-10-04-05.md).

### Phase 17: MP3 & FLAC Metadata

*Originally Phase 16.* **Acceptance:** import/preserve MP3 ID3 and round-trip mapped FLAC Vorbis comments with matching metadata fields and unchanged audio/save-state behavior.

- [ ] MP3 ID3 import/preservation and FLAC Vorbis comment import/export mapping, with matching metadata editor fields. Create dedicated upstream repositories only if the existing tagged codecs are insufficient. Current limits are in [codecs](docs/codecs.md#wav-metadata).

### Phase 18: Projects, Autosave & Recent Files

*Originally Phase 17.* **Acceptance:** after a crash (killed tab or Electron process), the last autosave restores within 5 s of the edit.

- [ ] `.aaep` project: a zip-like container of document blocks, optional history, markers and view state.
- [ ] OPFS-backed incremental autosave of dirty documents (only new blocks written) and crash recovery on startup.
- [ ] Application-owned recent files (browser: OPFS handles; desktop: native paths). OS recent-document acknowledgement already exists.
- [ ] `.aaep` desktop file association.

### Phase 19: Desktop Release & Installed Platform Acceptance

*Originally Phases 19 and 21.* **Acceptance:** signed installers for Linux (AppImage + deb), Windows (NSIS) and macOS (dmg) build in CI; file associations open documents and auto-update works on all three. Credentials and platform limits: [desktop](docs/desktop.md#updates-and-publishing).

- [ ] Configure signing credentials and the Linux package signature policy; verify signed/notarized installers in CI and installation/file associations on all target OSes.
- [ ] Verify a real installed old-version → new-version GitHub update on Linux, Windows and macOS (current tests stub the feed/installer).
- [ ] Verify Windows/macOS installer icons and installed audio associations (Linux already passes).
- [ ] Verify installed Windows/macOS packaged notices (`resources/licenses`) and typography.
- [ ] Run the native CLI/batch acceptance on Windows and macOS (Linux, UI 100-file parity and Electron folder processing pass).

### Phase 20: Hosting Cache & Browser Acceptance

*Originally Phase 20.* **Acceptance:** the public editor loads from a cold cache, reports `crossOriginIsolated === true`, imports a WAV, plays without underruns and exports it again, verified by live Playwright CI. Limits: [web deployment](docs/web-deployment.md).

- [ ] Strict hosting cache policy: GitHub Pages controls CDN headers (observed `max-age=600`), so never-cached HTML/worker and long-term immutable caching are not achieved; stale CDN HTML can still reference removed assets. Requires a host with header control or an equivalent mitigation.
- [ ] Firefox/Safari acceptance and native AAC encode acceptance (Chromium is the tested reference; Linux Chromium/Electron report AAC encoding unavailable).

### Phase 21: Restoration Listening Acceptance

*Originally Phase 18.* **Acceptance:** spectral click repair is inaudible on the reference fixtures; noise reduction achieves ≥15 dB on the stationary-noise fixture without audible musical noise at default settings. Numerical criteria pass (22.65 dB; click residual < −80 dBFS).

- [ ] Audition the reference fixtures for click inaudibility and musical noise at default settings. [Validation and limits](docs/restoration.md#validation-and-limits).

### Phase 22: MCP Completion

*Originally Phase 22.* **Acceptance:** Claude Code or Claude Desktop connects, opens a WAV, queries statistics, applies a chain and exports; output is sample-identical to the UI and `aae`, and every mutation is undoable. [Current surface](docs/mcp.md).

- [ ] Streamable HTTP transport (legacy SSE deferred).
- [ ] Read tools: offline true peak and silence detection (needs kernel/upstream work).
- [ ] Edit tools: cross-document extraction.
- [ ] Write tools: dedicated `render_region` and browser-only codec exports.
- [ ] Convolution IR loading for `apply_effect`.
- [ ] Dry runs for structural edits and whole chains, plus general output-LUFS prediction.
- [ ] Sensible numeric rounding and pagination of other long control results.
- [ ] Interactive acceptance with real Claude Code/Desktop hosts.
- [ ] *Optional:* evaluate exposing the desktop app's live session over MCP (Electron main hosts the server and forwards to the kernel worker), so an agent edits the document the user sees.
- [ ] *Optional, if taken:* a visible indicator and per-session consent while an agent is attached; mutations land in the user's undo stack.

### Phase 23: Visual Design Follow-up

*Originally Phase 24 open item.*

- [x] Consolidated standard filter menu/rack entry points in **Filter…** and A-/C-weighting in **Weighting filters…**, with full-width kernel frequency charts, compatible type/family selectors and only relevant controls (`effect-menu.ts`, `filter-controls.ts`, `filter-response-graph.tsx`, `EffectParameters`, `EffectsDialog`). Legacy node IDs remain supported. Focused UI tests and Chromium checks cover control switching, charts, responsive layout and Apply/Undo; full commit checks remain deferred during interactive design.
- [x] Narrower filter/weighting dialogs (80% of previous maximum), 320 px frequency charts down to −96 dB, and upstream Butterworth/Chebyshev orders through 20 (`algo-dsp v0.12.1`; Bessel 10 and elliptic 12 retained). Compact compressor uses a square plot beside two columns/three rows of knobs and a kernel-backed Auto gain checkbox; manual makeup stays stored, and keyboard/pointer curve inspection replaces the redundant slider/help (`DynamicsGraph`, `EffectParameters`). Focused upstream race tests, web tests/typecheck and Chromium checks cover real processing/response, control toggles, responsive geometry and exact Undo.
- [x] Extend the compact square-plot layout and 51.2 rem dialogs to Expander, Gate, Limiter and Lookahead limiter (`isCompactDynamics`, `EffectParameters`, `EffectsDialog`). Expander pairs Threshold/Ratio, Knee/Range and Attack/Release, with detector/topology/RMS controls below; Gate uses those main pairs with Hold/Topology below; limiters use only their supported knobs. Focused web tests/typecheck and Chromium checks cover Full HD fit, narrow-screen stacking, actual response updates, Preview, Apply and exact Undo.
- [x] Expose Feedforward/Feedback topology for every supporting dynamics processor: compressor, gate, expander and multiband compressor (all bands). `algo-dsp v0.12.2` adds missing catalogue/runtime wiring, with regressions for processing differences, sparse-graph compatibility, factory defaults and restoring Feedforward. Descriptor-driven editor dropdowns preserve the choice for preview, presets and offline Apply; topology may leave the static transfer plot unchanged.
- [x] Multiband compressor uses a crossover header and one row per band with six common knobs, a small actual band transfer graph and independent Auto gain (`MultibandParameters`, thumbnail `DynamicsGraph`). `algo-dsp v0.12.3` supports 2–4 bands, per-band envelope/makeup settings, selected-band `Chain.Transfer` inspection and four-band workspace accounting; default remains three bands. Shared legacy settings materialize on the first band edit; hidden bands and manual makeup survive toggles/count changes. Upstream race tests cover finite independent processing, zero allocations and 8/48/384 kHz storage bounds; kernel `TestMultibandResponseUsesEachActualBandGainComputer` verifies binary band curves (including thresholds below −60 dB) and invalid-index fencing; web tests cover legacy presets, per-band gain and hidden values. Chromium verifies six aligned knobs per row, four-band Full HD fit (819 × 1013 px), 640/320 px overflow-free wrapping, factory defaults, live Preview, Apply and exact Undo.

- [x] Dynamic EQ defaults to three peak bands at 120 Hz, 1 kHz and 8 kHz, with a full-width interactive Parametric EQ graph and horizontal band rows containing Type/Mode, all nine common knobs and right-aligned square I/O graphs (`DynamicEQParameters`, band `DynamicsGraph`). `algo-dsp v0.12.4` supplies selected-band `Chain.Transfer` through the actual `DynamicEQ.BandCurve`, including static offset, all four modes and range limits; low sample rates compress default frequency spacing. Hidden band settings remain stored. Upstream race tests cover catalogue/sparse defaults, known transfer values, live inspection state and zero-allocation rendering; kernel `TestDynamicEQResponseUsesBandModeOffsetAndRange` checks binary curves and invalid-index fencing. Fifteen focused web tests, typecheck and Chromium checks cover graph drag/right-click/wheel editing, independent controls/curves, presets, 128 px square plots, nine aligned knobs per row, Full HD fit (1024 × 1021 px), 1024/640/320 px overflow-free wrapping, live Preview, Apply and exact Undo. Full commit/CI checks remain deferred during interactive design.

- [ ] Continue visual review with user feedback: remaining populated/error/loading dialogs, combined dense multichannel/spectral/analysis states, complete small-screen focus/scroll access and contrast review at OS scaling settings. Installed Windows/macOS typography/scale is covered in Phase 19.
- [ ] Decide the zoomed-out waveform redesign and sinc interpolation for sample view (outside original Phase U's scope).

### Phase 24: Recording

*Originally Phase 7.* **Acceptance:** a 30-minute 48 kHz stereo recording has no dropped frames and lines up with playback within the measured round-trip latency. The Electron microphone permission is already in place.

- [ ] Capture worklet: input → SAB ring (the reverse of playback) → kernel worker appends blocks.
- [ ] Input device selection (`getUserMedia` with echo cancellation, noise suppression and AGC **off**).
- [ ] Input meters, record-arm and monitoring toggle.
- [ ] Record modes: new file, insert at cursor, replace selection (punch-in with pre-roll).
- [ ] Latency measurement (loopback ping) and compensation.

### Phase 25: Performance & Large Files

*Originally Phase 10.* **Acceptance:** a 3-hour 96 kHz stereo file (~4 GB as float32) opens, edits and plays with less than 1 GB of WASM heap resident.

- [ ] Block paging: cold blocks evicted to OPFS (browser) or a temp file (desktop) and faulted back on demand; the peak pyramid stays resident.
- [ ] Waveform rendering in an `OffscreenCanvas` render worker reading peaks directly.
- [ ] Profile the kernel render path in the browser; SIMD where algo-dsp provides it (`GOARCH=wasm` SIMD permitting).
- [ ] Benchmark suite with a regression guard in the style of algo-dsp's `benchguard`.
- [ ] Evaluate TinyGo for kernel size and speed (not a goal if the trade-offs are bad).

### Phase 26: Multitrack

*Originally Phase 11.* **Acceptance:** 16 stereo tracks, each with an effect chain, play without underruns on a mid-range laptop, and the mixdown matches offline rendering sample for sample.

- [ ] Session model: tracks → clips (document range, gain, fades, offset); non-destructive clip edits.
- [ ] Timeline view: tracks, clip drag/trim/split, snapping, time and bars/beats grid.
- [ ] Mixer: gain, pan, mute, solo, meters, bus sends, per-track `effectchain`.
- [ ] Automation lanes (gain, pan, effect parameters) with breakpoint editing.
- [ ] Mixdown/bounce to a new waveform document or file.
- [ ] Open a clip in the waveform editor (a destructive edit creates a new document version).

### Phase 27: License Policy Compliance

*Originally Phase 23 open items.* Policy confirmed by the user on 2026-10-05: **bundled code must be MIT/BSD/Apache only.** The strict gate `just check-license-policy` fails until this phase is done. Plans: [Go replacements](docs/licenses/go-replacements.md), [npm replacements](docs/licenses/npm-replacements.md), [Electron audit](docs/licenses/electron-audit.md).

- [ ] Replace or prove exclusion of: FLAC Unlicense, Go's retained SunPro/Cephes wording, remaining updater ISC, Python-2.0 and BlueOak-1.0.0. Resolve missing runtime grants in tagged `algo-vecmath`, FLAC's inherited BSD text and `lazy-val 1.0.5`. `algo-approx` and 38 development grants remain documented evidence gaps (informational while not redistributed). An SPDX label does not substitute for a missing runtime license. [Go evidence](docs/licenses/go-audit.md), [npm evidence](docs/licenses/npm-audit.md).
- [ ] **Go math:** complete symbol/source provenance across all seven targets (inlined code, constants, assembly inheritance, final optimized WASM attribution). Define numerical/allocation/performance contracts, implement required permitted transcendental functions upstream and replace callers through tagged releases. Recheck codec/standard-library reach and binary budgets; if SunPro/Cephes bodies remain, evaluate reproducible maintained toolchain replacements. [Requirements](docs/licenses/go-replacements.md#go-math-positive-linked-evidence-then-scoped-replacements), [reach report](docs/licenses/go-math-reach.md).
- [ ] **MIT FLAC (`tphakala/go-flac`) adoption:** obtain maintainer review and an audited upstream tag with the [local remediation](docs/licenses/flac-remediation.md) fixes (count/rate/channel/depth/sequence checks independent of MD5, bounded/skip metadata parsing, caller-controlled scratch ceilings, 32-bit residual encoding). Then complete per-file/contributor provenance, linked SIMD/math reach review, IETF corpus, bounded atomic import/writer regressions, one-hour memory/performance, native/WASM/browser parity and binary budgets. The current Unlicense dependency stays until adoption passes.
- [ ] Resolve the Electron/Chromium component license selections and platform reach recorded by `licenses-electron.mjs`.

### Phase 28: CI Stability & Release Process

*Originally R.1 / R.10 follow-ups.*

- [ ] **Allocation flake:** `internal/effects/stream_test.go` (`AllocsPerRun`, "prepared auto-wah render+reset allocate 1") failed in 1 of 6 local `-race` runs. Find the stray allocation or make the measurement robust before it reddens CI. Later isolated and full-catalogue repetitions passed; process-global allocation counters are a suspected, unconfirmed source. [Evidence](docs/benchmarks/r1-ci-2026-10-05.md#allocation-flake).
- [ ] **Short-file EOF snapshot flake:** one parallel `transport.spec.ts` run reported frame 13 instead of 31. Repetitions with passive DOM/output-clock/shared-counter diagnostics pass; the cause is open. Keep the exact 31-frame, zero-underrun and replay assertions. [Evidence](docs/benchmarks/r1-ci-2026-10-05.md#short-file-eof-flake).
- [ ] Configure required successful CI checks for contributions where applicable, preserving the authorized direct-main workflow (the branch protection API currently reports `Branch not protected`).
- [ ] Agree the `v0.1.0` development-release scope with unfinished metadata/persistence (Phases 17–18) explicit; complete the [first-release prerequisites](docs/releasing.md#first-release) (Phases 19 and 27), dependency checks and CI for the release commit before tagging. The first tag also establishes the `check-unreleased` baseline.

---

## Deferred / Later

- VST3/CLAP plugin hosting (desktop only, via a native helper process)
- MIDI input for transport control
- Video track for post-production sync
- Collaborative editing
- Scripting API (JS or Lua) on top of the operation model
- Localization (UI strings are English for now)
