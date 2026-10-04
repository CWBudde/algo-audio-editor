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
> - **ABI:** `AAEKernel.call(method, json, data?) → json` for control and optional binary input, `AAEKernel.takeData()` for the preceding call's binary output, `AAEKernel.render(u8, frames, positions?)` for audio and optional int64 document-position tags, and `AAEKernel.copyMeters(u8)` for the reusable binary output-meter snapshot. Methods and payloads are defined in `packages/kernel/internal/protocol` and mirrored by hand in `packages/protocol`. Bulk data (audio, peaks, files, spectra, pitch records, RGBA tiles) crosses as transferable `ArrayBuffer`s or through the SAB, never as JSON arrays.
> - **Cross-origin isolation** (needed for SharedArrayBuffer) comes from:
>   - COOP/COEP headers in Vite dev/preview,
>   - `coi-serviceworker.js` on GitHub Pages,
>   - the `app://` protocol handler in Electron.

**Product shape (decided 2026-10-02):** a waveform editor first, in the spirit of ocenaudio, Sound Forge or Audition's waveform view. Multitrack comes in Phase 11 and is built on the same block-based document model.

---

## Roadmap status (2026-10-05)

Completed implementation is summarized below. Unfinished acceptance, platform and feature work has moved to explicit follow-up phases; **COMPLETE applies to the scope stated in each summary**, not to its follow-up. Open requirements and partial-progress evidence are retained. Detailed completed-phase history is available in Git at `9de516f:PLAN.md`; old test counts and dependency versions describe those historical runs, not the current build.

**Next review work:** R.5, followed by R.8–R.10; R.1 still has CI/lint follow-ups. Feature phases remain separately schedulable, with Electron permission hardening in R.9 required before recording.

| Previous location | Remaining work | New location |
| --- | --- | --- |
| Phase 3.2 | Full-editor processing performance acceptance | Phase 15 |
| Phases 5 / 8 | Spectrogram playback timing reconciliation | Phase 15 |
| Phase 6.3 | MP3/FLAC metadata mapping | Phase 16 |
| Phase 6.4; Phase 9 project association | Projects, autosave, recent files, `.aaep` association | Phase 17 |
| Phase 8 | Subjective restoration acceptance | Phase 18 |
| Phase 9 | Signing, installed associations and real updates | Phase 19 |
| Phase 13 | Strict hosting cache policy and browser acceptance | Phase 20 |
| Phase 12 | Native Windows/macOS batch execution acceptance | Phase 21 |
| Phase 14 | Remaining MCP surface, transport and host acceptance | Phase 22 |
| Phase S | Dependency license audit and notices | Phase 23 |

Phase IDs 0–14 and U remain as historical implementation references. Review IDs R.1–R.10 stay stable for the review document; completed review sections are summarized alongside the completed feature phases. No unfinished acceptance gate has been waived.

## Completed implementation

### Phase 0: Scaffolding & End-to-End Pipeline — COMPLETE (2026-10-02)

- [x] Bun/Go monorepo, `just`, formatting/lint/hooks, mirrored protocol and platform-independent kernel; Worker → SAB → copy-only AudioWorklet playback in browser and sandboxed Electron. Kernel tone/render, RPC/ring and both shell smoke regressions cover isolation, ownership, failures and zero-allocation rendering.
- [x] CI, Pages and dependency-drift workflows exist. Browser/Electron CI first actually ran after the 2026-10-04 R.1 fix; CI/release hardening still pending is listed under R.1.

### Phase 1: Document Model, WAV I/O, Waveform & Playback — COMPLETE (2026-10-03)

- [x] `internal/audiobuf` provides immutable 65,536-frame blocks, shared channel/document snapshots, deduplicated memory and cached peak pyramids. WAV I/O, waveform zoom/scroll and source-position-tagged transport have native/WASM ownership, long-offset, codec and render regressions.
- [x] `use-document.ts` overlaps reading with playback shutdown; fitted lane/overview peaks are shared. `interleaved_test.go`, `bench-import-profile` and `import-benchmark.spec.ts` cover exact copy bits and full import-to-painted-waveform work. Isolated target-laptop ten-minute import and one-quantum cursor gates pass; host contention produced historical failures, so these are not worst-case guarantees.

### Phase 2: Selection & Editing — COMPLETE (2026-10-03)

- [x] Exact numeric/pointer/channel selection, marker/ruler/upstream zero-crossing snapping, cut/copy/delete/paste insert/replace/unclipped mix, crop, silence, duplicate, swap and mute. `internal/ops`, clipboard windows and conversion preserve shared source blocks; native/WASM goldens and actual exported browser PCM cover bits, masks, EOF and atomic failure.
- [x] `internal/history` provides exact undo/redo/jump/branch and acknowledged save points; document-owned markers/regions transform with edits, round-trip WAV cue/adtl and export CSV/labels. Timeline/history and one-hour storage regressions cover sharing, annotations and bounded retention. Stronger at-capacity WASM edit benchmarks showed variance around 50 ms.
- [x] Shared command registry, platform shortcuts and palette route menus/actions with modal/text-input fences. Browser/Electron regressions cover command routing, conversion confirmation, source/history preservation and successful-write-only Save acknowledgement.

### Phase 3: Basic Processing & Export Quality — IMPLEMENTATION COMPLETE (2026-10-03)

- [x] `internal/process`, engine jobs and worker runners provide bounded cancellable private candidates, Preview/Stop/Apply/Cancel, unsafe-output acknowledgement and one atomic undo entry. Goldens and lifecycle/browser/Electron tests cover gain, peak/LUFS normalization, four fade/crossfade curves, reverse, invert, DC removal, channel conversion/extraction, Fast/Balanced/Best resampling and seeded generators.
- [x] LUFS normalization independently measures actual rounded candidate samples before commit; exact finite-peak proofs and bounded batches consume tagged upstream analyzers. Individual isolated LUFS/extraction gates pass; the complete ten-minute performance matrix remains Phase 15.
- [x] `export.go`, `ExportDialog` and `useExport` provide selection/channel scope, PCM8/16/24/32 or float32/64 WAV, seeded dither and noise shaping without changing source/save state. Independent integer-code, clipping/feedback, bridge and real disk/download regressions cover export; required APIs were released upstream before tagged consumption. The historical short-file EOF cursor concern is retained in R.1.

### Phase 4: Effects — COMPLETE (2026-10-03; UI refinements 2026-10-04)

- [x] `internal/effects` exposes all 51 upstream default-registry effects, sample-rate-aware controls/presets, bounded racks, convolution IRs, latency compensation and atomic updates. Preview and offline Apply share prepared 128-frame DSP quanta; native/WASM tests compare exact samples, pairing, tails, reset, ownership and zero allocations. Catalogue browser acceptance exercises every effect and undo.
- [x] Grouped menus, compact unit-labeled editable knobs, EQ responses with smaller handles/right-click type menus, dynamics I/O plots, bypass/wet-dry and persistent OPFS/Electron presets. Component/browser/Electron regressions cover graph interaction, focus, eight-band Full HD fit, narrow layouts and persisted IRs.
- [x] Tagged upstream WSOLA, convolution partitioning and streaming updates meet the unchanged 50 ms parameter-change gate in consecutive isolated Chromium runs with zero underruns. Timing uses the muted browser output-clock estimate; external DAC/speaker latency was not measured.

### Phase 5: Analysis & Metering — IMPLEMENTATION COMPLETE (2026-10-04)

- [x] `meters.go` / binary meter snapshots and upstream loudness, true-peak and stereo analyzers provide allocation-free rendered-output meters, LRA, holds and goniometer data. Published EBU fixtures pass native/V8-WASM tolerances through upstream and editor paths; fixtures stay external under their usage terms.
- [x] Bounded selection/live spectra, progressive cached spectrogram tiles, statistics, resumable YIN pitch tracking and clipping-marker transactions. Kernel/frontend and browser/Electron regressions cover physical channels, settings, cancellation, stale identities, unchanged audio and exact undo. The originally passing ten-minute spectrogram gate and later failures require reconciliation in Phase 15.

### Phase 6: Codec I/O & WAV Metadata — IMPLEMENTATION COMPLETE (2026-10-04)

- [x] `engine/codecs.go` imports tagged Go WAV/FLAC/AIFF/MP3; browser-native decoding handles supported Vorbis/Opus/AAC containers into binary planar PCM. Native WAV/FLAC/AIFF export and supported WebCodecs Opus/M4A copies preserve kernel-owned sample processing. Independent FFmpeg/reference-codec fixtures, native/WASM/fuzz and browser/Electron round trips cover format detection, checksums, PCM, cancellation and save-state behavior; limits are in `docs/codecs.md`.
- [x] `wav_metadata.go`, `MetadataDialog` and `useMetadata` map/edit 16 WAV INFO fields, retain unknown INFO/BWF/opaque data and annotation supplements, and create metadata-only undo entries. Wire fixtures and disk/download/reopen tests verify bounded ownership, exact PCM and source state. BWF is retained rather than edited; opaque references are not recalculated after edits. FLAC/AIFF reject included metadata until mapping exists, and lossy exports omit annotations.
- [x] MP3 mono/gapless behavior and PCM8 centering were corrected in R.3. Browser AAC availability/codec delay and platform limits remain explicit; missing metadata/persistence and platform acceptance are in Phases 16–17 and 19–20.

### Phase U: Editor Clarity & Sample Detail — COMPLETE (2026-10-03)

- [x] Responsive file footer, on-demand About diagnostics, compact icon bands/disclosures, selection/timeline controls and centralized purple/orange/yellow roles. Component and production shell regressions cover command routing, numeric drafts, modal fences, accessibility, focus and desktop/narrow layout.
- [x] `waveform-samples.ts`, `drawSampleWaveform`, `PeakCanvas` and paged peak queries draw signed sample dots above one CSS pixel/sample with linear/hold connections. Actual pixel tests cover DPR thresholds, sign, seams/EOF, cached redraw and unchanged audio/history; overview envelopes stay intact. Sinc interpolation and the undecided zoomed-out redesign remain outside this completed scope.

### Phase 8: Restoration & Advanced Editing — IMPLEMENTATION COMPLETE (2026-10-04)

- [x] Rectangle/lasso spectral attenuation/removal/healing, captured-profile Wiener/subtraction/gate noise reduction, bounded click/pop repair and declipping, stereo-coherent WSOLA time stretch and hum notches consume tagged upstream restoration/stream APIs. `docs/restoration.md` records workflows and limits; goldens and kernel/browser tests cover numerical quality, source preservation, cancellation, geometry and undo.
- [x] Reference fixtures measure 22.65 dB default stationary-noise reduction and click residual below −80 dBFS after float32 storage; musical-noise proxies pass. Subjective listening remains Phase 18, and unresolved spectrogram timing is Phase 15.

### Phase 9: Native Desktop Integration — IMPLEMENTATION COMPLETE (2026-10-04)

- [x] Native menus/dialogs, renderer-scoped file capabilities, atomic writes, audio file associations/open routing, single-instance behavior, OS recent-document acknowledgements, persisted window state and guarded Save/Discard/Cancel close. Electron regressions cover actual second-process opens, disk output, close/save failures and relaunch.
- [x] `electron-builder.yml`, `updates.ts` and `desktop-release.yml` provide three-OS packaging, guarded updater flow and signing-gated release scaffolding. Linux AppImage/deb and packaged ASAR/isolation smoke pass; deterministic updater tests stub the feed/installer. Actual signing, installed associations and installed updates remain Phase 19; projects/recent persistence remain Phase 17.
- [x] `assets/appicon.png` and `just icons` generate checked-in Windows/macOS/Linux/web icons. Size/reproducibility, Linux package icon bytes and native/renderer loading regressions pass; Windows/macOS installed icon acceptance remains Phase 19.

### Phase 12: Batch & Automation — IMPLEMENTATION COMPLETE (2026-10-04)

- [x] Strict version 1 operation chains, native `cmd/aae`, isolated per-file WASM UI batches, macro recording/import/export/replay and atomic authorized output publication. The production UI's 100-file normalize/fade/resample/FLAC batch is byte-identical to the compiled Linux CLI; cancellation, partial failures, clipboard/history isolation and native folder grants have regressions. Full implementation context and Windows/macOS acceptance remain in Phase 21.

### Phase 13: Public Web Deployment — IMPLEMENTATION COMPLETE (2026-10-04)

- [x] CI-gated `main` publishes at `https://cwbudde.github.io/algo-audio-editor/`; scoped isolation worker, matched hashed kernel/runtime assets, cold/warm/headerless subpath boot and live post-deploy/daily smoke cover import/playback/export. The `37f1cbd` CI/deploy and public smoke succeeded. Build stamps, CC0 demo, development label, icons/social metadata, screenshot and deployment/browser docs are delivered.
- [x] `check-web-budget.mjs` gates production assets; R.7 adds optimized WASM and chunk limits. Strict CDN caching and untested browser/native AAC acceptance remain Phase 20; propagation/network failures stay visible in smoke traces/retries.

### Phase 14: Native MCP Foundation — IMPLEMENTATION COMPLETE (2026-10-04)

- [x] Official SDK stdio `cmd/aae-mcp`, isolated document sessions, 18 tools, generated schemas, summaries/waveform PNG/binary peak resources, prompts, private-candidate dry runs and write-root capabilities use the shared automation/kernel engine. SDK/native subprocess tests verify schema/PCM/resource identity, partial-chain errors and source/history safety; compiled MCP and CLI normalize/resample/FLAC outputs match exactly. Full context and unfinished tools/transports/host acceptance remain Phase 22.

### R.2: Kernel robustness — COMPLETE (2026-10-04)

- [x] RPC panic recovery, shared 3 GiB retained-storage/candidate budget with 1 GiB WASM headroom, pre-allocation bridge/codec checks, owner-sized history bounds and atomic rejection. `memory_test.go` covers import/export, clipboard/conversion, reservations, growth and overflow; actual one-hour FLAC import remains R.5.
- [x] Tolerant interrupted RIFF/RF64 recovery retains complete frames while validating metadata; `wav_robustness_test.go` covers boundaries/export/reopen. Bounded `FuzzWAVOpen`, `FuzzCodecOpen` and `FuzzDocumentExport` run in `just ci`; native race, V8/WASM, lint/vet and fuzz smoke checks pass.

### R.3: Kernel correctness — COMPLETE (2026-10-05)

- [x] `mp3.go` preserves mono and bounded Xing/LAME gapless endpoints with the decoder offset; independent FFmpeg PCM, CRC/MPEG-2/VBR, seam and malformed-header regressions pass. Tagged `wav v0.1.4` fixes centered PCM8 with exhaustive byte round trips.
- [x] Tagged `algo-dsp v0.10.1` owns BS.1770 channel weights and unpadded/reflected noise-capture framing. Surround normalization/statistics/meters/export-reopen and exact window-power regressions pass. Subset cursor generators insert synchronized unselected-channel silence with timeline/undo tests; codec short-read errors and missing-history analysis guards are covered.
- [x] Native race, actual V8/WASM, lint/vet, fuzz, tagged-dependency and upstream release checks pass; ABI unchanged.

### R.4: Move DSP upstream — COMPLETE (2026-10-05)

- [x] Tagged `algo-dsp v0.10.2` supplies preflighted `resample.StreamPlan`/`Stream` for transport, clipboard and offline resampling. Adapter bit-parity, independent FIR/tails, extreme ratios, loop/seek, workspace and zero-allocation regressions cover the removal of local delay/flush/GCD copies; R.3 moved loudness weights/noise framing upstream.
- [x] Upstream `signal.AddInto32` / `AverageInto32` remove wide mix/downmix scratch while preserving unclipped bits, signed zero, subnormals and overflow-safe averages. Native race/V8-WASM, lint/vet/tidy/dependency, production build/budgets and ten focused Chromium checks pass; ABI unchanged.

### R.6: Frontend correctness — COMPLETE (2026-10-04)

- [x] Worklet retirement, allocation-safe split-word ring/cursor reads, serialized Play and shared ref-backed selection eliminate lifecycle/state races. Lost mutating replies recover authoritative `doc.info`; null/empty wire types, generated Go/TS schema parity and single main-thread peak decoding have focused regressions. Frontend/lint/type/build checks pass; the stale 512 MiB browser expectation is retained under R.1.

### R.7: Frontend structure & performance — COMPLETE (2026-10-05)

- [x] Shared kernel-session/job lifetime guards, extracted App/waveform modules, isolated stats/meters polling, bounded follow updates and stable command/layout callbacks. Completed peaks/pixels remain visible while replacements load; hook/component/production regressions cover stale sessions, render counts and delayed pan/zoom.
- [x] Lazy dialogs/React chunk, hashed pinned Binaryen-optimized WASM and raw/gzip budgets gate every production build/CI. Typed `process-probe.ts` supports benchmark wire observation with unit tests. Frontend, lint/type/format/workflow and optimized build/budget checks, focused Chromium/Pages and Electron smoke pass; hardware timing gates and full CI were not run for this review section.

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

## Phase 15: Processing & Playback Performance Acceptance — OPEN

**Source:** unfinished Phase 3.2 acceptance and the Phase 5/8 spectrogram playback discrepancy.

**Goal:** Complete the everyday destructive-processing performance requirement without reducing quality, widening limits or skipping actual output verification.

**Acceptance criterion:** Every process has a Go golden test against a reference vector; processing a ten-minute stereo file takes <1 s; long jobs show progress and cancel without document corruption. Spectrogram rendering of a ten-minute file progresses without blocking playback or dropping samples.

### Processing matrix

- [ ] **Full-editor performance acceptance:** `process-benchmark.spec.ts` now defines 32 serial ten-minute scenarios across all operations/shapes/profiles. The unchanged clock includes Apply, bounded processing, actual LUFS verification, atomic commit and painted channel/overview waveforms; extraction includes binary handoff, destination import and painting. No Preview or prepared candidate precedes the clock. The first tagged v0.7.8 sweep passes gain **645.090 ms**, peak **687.250 ms**, reverse **594.840 ms**, invert **717.975 ms** and mono mix/left/right **748.565 / 139.520 / 175.305 ms**. Preserved failures: LUFS **2175.115 ms**, DC **1641.890 ms**, fade in/out linear **2135.710 / 1573.740 ms**, equal-power **3317.555 / 3809.825 ms**, logarithmic **5223.520 / 7673.415 ms**, S-curve **1510.965 / 1532.415 ms**, and resampling Fast/Balanced/Best **8661.140 / 11488.520 / 36107.710 ms**. Crossfades, mono expansion, generators and extraction initially failed benchmark setup without producing timings; their real sample-unit/command-label setup has been repaired. The <1 s requirement remains pending, with no tolerance or quality reduction.
  - [x] **Exact upstream/kernel optimization:** published guarded **v0.7.9** (`ab06415`) and bumped/tidied the tagged dependency. Hoisted fade/generator invariants and resampler phase arithmetic, steady-input FIR loops and sequential unrolling preserve original sample arithmetic; a slower grouped-coefficient experiment was rejected before publication. Tagged `EnvelopeInto64`, `ApplyEnvelopeInto32` and `CrossfadeEnvelopeInto32` share unrounded curves across channels. Concrete owned-block adapters avoid an output copy; deterministic generators share immutable output blocks while noise streams remain independent. Independent native/race/WASM goldens cover source and caller-storage ownership, global positions, all shapes, channels and unsafe telemetry. Processing coverage is **90.5%**. Resampler preflight includes all float64 telemetry scratch; a coprime boundary case rejects before filter allocation. Independent filter-response measurements confirm reducing taps would weaken anti-aliasing, so profiles stay unchanged.
  - **Preserved v0.7.9 serial browser sweep:** all owned CPU jobs were idle. **18 timing cases pass**: gain **844.225 ms**, peak **581.085 ms**, linear fade in/out **524.640 / 601.210 ms**, S-curve **625.260 / 688.555 ms**, crossfade linear/equal-power/logarithmic/S-curve **86.530 / 100.035 / 145.180 / 81.305 ms**, reverse **549.920 ms**, invert **489.755 ms**, mono expansion **123.050 ms**, mono mix/left/right **413.595 / 138.545 / 110.425 ms**, silence **392.995 ms**, white noise **905.650 ms**. **13 measured failures remain**: LUFS **1603.815 ms** (source analysis **573.010 ms**, rendering plus actual stored-output measurement **954.270 ms**, final gating **4.160 ms**, measured output **−22.9999999905 LUFS**), equal-power fades **1243.680 / 1048.080 ms**, logarithmic fades **2048.140 / 1244.525 ms**, DC **1055.530 ms**, Fast/Balanced/Best resampling **4170.375 / 4576.455 / 8204.320 ms**, sine **1375.850 ms**, pink noise **2915.330 ms**, linear/log sweeps **1539.360 / 3095.105 ms**. Extraction completed its source-side workflow but its destination-paint observer timed out without a metric; investigation follows. No operation's timing limit was increased and no prepared Preview was used.
  - [x] **Actual LUFS scan optimized and verified:** published guarded **v0.7.10** (`c074c80`) and bumped/tidied the editor module. `TargetAnalyzer.ProcessCertifiedPlanar32` accepts an exact finite sample-peak proof, then still processes every actual sample through its K filters, windows and gates. `audiobuf.TargetFeedBuffer` derives that proof from exact immutable `Block/Channel.FinitePeak` summaries for the source and rounded candidate; unsafe input retains ordinary atomic preflight. Independent copied-plan/output measurement comparisons cover partitions, below-gate and extreme/subnormal inputs, zero-weight peak channels, unsafe samples outside selection, descriptor clearing, ownership and zero allocations. Upstream native/race/WASM CI and compatibility guard pass; the new certified API and shape helper have 100% statement coverage. Editor `just ci`, every actual-WASM kernel package and latest sibling checks pass: **746 frontend tests**, both typechecks, storage **97.8%**, processing **90.5%**, engine **91.1%** race coverage. All **90 browser functional tests** and both Electron tests pass against the final official tag.
  - **Isolated final targeted gates:** LUFS passes at **921.525 ms** (source analysis **315.285 ms**, rendering including actual stored-output measurement **529.810 ms**, final gating **0.070 ms**), with measured output **−22.9999999905 LUFS**, exactly one committed state, 229 bounded progress events and a **10.625 ms** maximum gap. Extraction passes at **835.235 ms**, including transfer/import/paint of **115200000 bytes**, with exact samples and unchanged source history. The extraction observer now reattaches after the popup's initial blank document; diagnostic runs **745.695 ms** and **1755.150 ms** are preserved as host-sensitive evidence, the latter with concurrent checks and no acceptance claim. The isolated cursor gate passes with **20 readings**, **eight frames** maximum error and **zero underruns**, retaining the one-quantum limit. No CPU affinity or prepared Preview was used for these editor gates.
  - **Final complete v0.7.10 sweep:** all 32 cases now produce actual metrics, with **17 passes / 15 timing failures**; all sample/geometry/metadata/history/painting assertions pass. Timings (ms) are gain **1219.445**, peak **815.150**, LUFS **1147.220**, linear fade in/out **697.375 / 977.615**, equal-power **2163.320 / 1175.600**, logarithmic **2264.265 / 2161.565**, S-curve **820.335 / 965.500**, crossfades linear/equal-power/logarithmic/S-curve **250.715 / 114.730 / 151.155 / 117.270**, reverse **877.940**, invert **846.320**, DC **1435.560**, mono expansion **198.055**, mono mix/left/right **812.950 / 122.995 / 142.740**, Fast/Balanced/Best resampling **5168.175 / 6610.805 / 9759.155**, silence/sine/white/pink generation **427.250 / 1574.025 / 1415.695 / 2559.255**, linear/log sweeps **1289.585 / 1568.480**, extraction **777.350**. The repeat LUFS failure remains alongside its isolated passing result. Host load during the sweep was **9.39 / 6.50 / 4.45** on 12 logical CPUs, CPU pressure averaged about **10–12%**, and sampled P/E core frequencies were **3.3 / 2.5 GHz**; every owned job was idle except the serial browser runner. The overall <1 s acceptance criterion remains unchecked. Further DSP optimization is required for nonlinear envelopes, generators, DC and especially scalar quality-preserving FIR resampling; no quality/tap reduction, widened budget or skipped verification is used. The final unchanged ten-minute import gate passes at **617.690 ms**, including file read, document UI and painted waveforms.

### Spectrogram playback gate

- [ ] Reconcile the initially passing Phase 5 measurement with the later Phase 8/baseline failures, profile the cause and rerun the original gate without relaxing timing or underrun limits.

**Historical Phase 5 result:** Isolated production playback acceptance passes: the full **28,800,000-frame, ten-minute stereo** file progressively paints both channel spectrograms, observes **1209 painted columns**, and completes the measured tile-render window in **17.562 s** with live meters, advancing playback and **zero underruns** before/during/after. `spectrogram-playback.spec.ts` uses a temporary WAV path to retain the full fixture despite Playwright's 50 MB in-memory upload limit. The six existing timing gates also pass unchanged: five effect updates **40.227 / 42.228 / 44.832 / 38.453 / 47.553 ms**, and the cursor's 20 readings have maximum **7 frames** error, all with zero underruns. Timing uses the same muted Chromium output-clock estimate documented in Phase 4; meters deliberately show rendered output ahead of the device.

**Playback timing:** six of seven existing gates pass, including the isolated effects reruns (audible changes <50 ms, zero underruns). The ten-minute spectrogram gate reports underruns on this machine in both Phase 8 (1025 dropped samples on the isolated rerun) and an unchanged production build of `9cf7988` / `algo-dsp v0.9.0` (6914). This pre-existing gate remains unresolved; no timing threshold is relaxed.

---

## Phase 16: MP3 & FLAC Metadata — OPEN

**Source:** Phase 6.3; WAV metadata implementation is complete.

**Goal:** Open what users actually have while retaining editable codec metadata.

**Acceptance criterion:** Import/preserve MP3 ID3 and round-trip mapped FLAC Vorbis comments, with matching metadata fields and unchanged audio/save-state behavior.

- [ ] MP3 ID3 import/preservation and FLAC Vorbis comment import/export mapping, followed by matching metadata editor fields. Dedicated upstream repositories are needed only if existing tagged codecs are insufficient.

**WAV metadata validation (2026-10-04):** `just ci` passes with **907 frontend tests in 69 files**, native Go race/coverage, lint/typechecks, formatting/tidy and production build; the complete V8/WASM kernel suite also passes. All **27 focused production Chromium metadata/codec/export tests** and **nine focused Electron native/codec tests** pass, including real download/disk write/reopen, modal fencing and unchanged PCM/source state. Metadata regression fixtures are constructed independently on the RIFF wire, covering opaque/BWF bytes, legacy INFO text, field deletion, annotation supplements, selection filtering and uninterrupted kernel transport. Current sibling tags and a WAV fuzz smoke pass. MP3/FLAC tags and Phase 6.4 persistence remain pending.

**Current limits:** WAV INFO, unknown INFO, BWF/opaque payloads and cue supplements are preserved; BWF fields are not edited and opaque references are not recalculated after audio edits. FLAC/AIFF export rejects included annotations/metadata until mapping exists; lossy export explains omission. Metadata is bounded to 2 MiB and editable text to 64 KiB. Dedicated repositories are needed only if existing tagged codecs are insufficient; see `docs/codecs.md`.

---

## Phase 17: Projects, Autosave & Recent Files — OPEN

**Source:** Phase 6.4 and the Phase 9 project-association follow-up.

**Goal:** Save projects safely and never lose work.

**Acceptance criterion:** After a crash (killed tab or Electron process), the last autosave restores within 5 s of the edit.

- [ ] `.aaep` project = a zip-like container of document blocks, history (optional), markers and view state
- [ ] OPFS-backed autosave of dirty documents (incremental: only new blocks are written) and crash recovery on startup
- [ ] Recent files (browser: OPFS handles; desktop: native paths)
- [ ] Add `.aaep` association after Phase 6.4 project support. Browser/project recent-file persistence also remains Phase 6.

**Dependency mapping:** “Phase 6.4 project support” in the retained task above means this phase. Desktop OS recent-document acknowledgement already exists; application-owned browser/project persistence does not.

---

## Phase 18: Restoration Listening Acceptance — OPEN

**Source:** Phase 8 perceptual acceptance; implementation and numerical proxies are complete.

**Goal:** Confirm the reference repairs sound acceptable at default settings.

**Acceptance criterion:** Spectral repair of a click is inaudible on the reference fixtures, and noise reduction achieves ≥15 dB on the stationary-noise fixture without audible musical noise at default settings.

- [ ] **Perceptual acceptance:** audition the reference fixtures for click inaudibility and musical noise at default settings. Numerical criteria and artifact proxies pass; subjective listening is not claimed by automated tests.

**Validation:** `just ci`, actual V8/WASM kernel tests and `just check-deps` pass. Frontend: 869 unit tests. Chromium: 116 scenarios pass in the full parallel run; the existing YIN analysis scenario hits its 5-second result timeout during concurrent Electron testing and passes on an isolated rerun. Electron: all six scenarios pass. Processing coverage is 90.3%; engine coverage is 87.8%.

**Playback timing:** six of seven existing gates pass, including the isolated effects reruns (audible changes <50 ms, zero underruns). The ten-minute spectrogram gate reports underruns on this machine in both Phase 8 (1025 dropped samples on the isolated rerun) and an unchanged production build of `9cf7988` / `algo-dsp v0.9.0` (6914). This pre-existing gate remains unresolved; no timing threshold is relaxed.

**Existing evidence:** Kernel/browser fixtures measure 22.65 dB default stationary-noise reduction after float32 storage, unchanged noise-profile audio and click residual below −80 dBFS. Upstream tests bound residual-power variation/isolated lines and wanted-tone loss as proxies. Default Wiener filtering uses a 2048-point FFT and 24 dB maximum reduction; repair supports ≤256 samples with intact two-sided context and leaves longer/edge damage unchanged. Workflows, controls, lineage and limits are in `docs/restoration.md` and upstream restoration documentation. Spectrogram timing is tracked independently in Phase 15.

---

## Phase 19: Desktop Release & Installed Platform Acceptance — OPEN

**Source:** Phase 9 external release/installation acceptance; native integration and Linux package smoke are complete.

**Goal:** The desktop build feels native and installs like a normal application.

**Acceptance criterion:** Signed installers for Linux (AppImage + deb), Windows (NSIS) and macOS (dmg) build in CI. File associations open documents, and auto-update works on all three.

- [ ] Configure signing credentials and Linux package signature policy; verify signed/notarized installers in CI and installation/file associations on all target OSes. No release has been published during implementation.
- [ ] Verify an actual installed old-version-to-new-version GitHub update on Linux, Windows and macOS. Deterministic restart-flow tests do not establish installer/signature acceptance.

**Validation:** `just ci` (native Go race tests, lint/types, formatting, module tidy, production build), 880 frontend tests, all 117 functional Chromium scenarios across the full run and isolated reruns, all 11 ordinary Electron scenarios plus the Linux packaged smoke, a frozen Bun 1.4.2 install, and `actionlint` for both changed workflows. Under concurrent host load, some existing browser/Electron/unit waits timed out; all affected cases pass in isolated reruns with the original limits. Linux AppImage and deb build locally. Phase 9 is intentionally partial: Phase 6 projects/persistence and external signing/release acceptance remain unimplemented.

- [ ] Verify Windows/macOS installer icons and installed audio associations; Linux icon regeneration, AppImage/deb builds and installed deb icon bytes already pass. `.aaep` association depends on Phase 17.

**Implemented context:** `desktop-release.yml` uses tag-triggered three-OS builds, version injection, signing-credential checks and forced Windows/macOS signing; only a complete platform set publishes. Manual runs produce artifacts without publishing. Installer/update manifests, blockmaps and macOS updater zip are included. Local packaging never publishes. `updates.spec.ts` stubs the update feed/installer and proves guarded save-before-restart, not real installation or signature acceptance. `docs/desktop.md` records credentials and platform limits. No release has been published during implementation.

---

## Phase 20: Hosting Cache & Browser Acceptance — OPEN

**Source:** Phase 13 delivery-quality follow-up and documented browser/codec platform limits.

**Goal:** A cold visitor can use the public editor reliably, with explicit platform and cache limits.

**Acceptance criterion:** `https://cwbudde.github.io/algo-audio-editor/` loads from a cold cache, reports `crossOriginIsolated === true`, imports a local WAV, plays without underruns and exports it again; live Playwright CI verifies the deployed build. Existing Chromium smoke passes, while strict caching and additional platform acceptance below remain open.

- [ ] Strict hosting cache policy remains pending: hashed JS/CSS/kernel/runtime URLs, no application CacheStorage, controlled navigation `no-store` and uncached worker updates are implemented and tested. GitHub controls first-response/CDN headers (observed `max-age=600`), so never-cached HTML/worker and long-term immutable caching are not claimed. Stale CDN HTML can still reference removed assets; limits are documented in `docs/web-deployment.md`.

- [ ] Complete documented Firefox/Safari and native AAC acceptance. Chromium is the tested reference; `docs/web-deployment.md` documents feature requirements, blocked-isolation guidance and runtime codec checks. Linux Chromium/Electron report AAC encoding unavailable. The encoder-substitution test verifies actual M4A muxing/browser decoding against independent FFmpeg AAC packets and ADTS PCM, without claiming native AAC encode. AAC delay/padding is retained; Opus export requires 48 kHz (other rates need the Go Resample command), because Chromium low-rate raw headers report pre-skip in native units. The archived pinned MIT `mp4-muxer 5.2.2` and remaining platform limits are documented in `docs/codecs.md`.

**Existing delivery evidence:** Scoped isolation-worker boot, uncached worker updates, matched hashed assets, controlled navigation and no app CacheStorage are tested. Cold WAV import/playback/exact-PCM Save passed on a fresh live retry; an earlier cold load exceeded readiness, so propagation/network failures remain visible with traces/retries. The live `37f1cbd` post-deploy smoke and build stamps passed; this does not establish strict CDN headers.

---

## Phase 21: Batch & Automation Platform Acceptance — OPEN

**Source:** Phase 12. Full implementation and acceptance context is retained below.

- [ ] Run the native CLI/batch acceptance on Windows and macOS; Linux native, production UI 100-file parity and Electron folder processing already pass.

**Goal:** Apply the same processing to many files, from the UI or headless.

**Acceptance criterion:** A batch job (normalize to −16 LUFS, fade the edges, convert to 44.1 kHz/16-bit FLAC) processes 100 files from the UI and gives an identical result through the native CLI.

- [x] Version 1 JSON operation chains (`internal/automation.Chain` / `Operation`, mirrored as TypeScript `OperationChain` / `RecordedOperation`) record the existing UI `edit.apply`, `process.start` and `effects.apply` payloads. Strict decoding rejects unknown fields/methods; the runner follows kernel identity changes, resolves omitted range fields from the current selection and reports a completed prefix on failure. Maximum 64 operations; cross-document extraction remains excluded.
- [x] `BatchDialog` / `useBatch` add File → Batch processing with a multi-file list, imported/current macro chains (or empty conversion), portable suffix names, duplicate-name preflight, WAV/FLAC/AIFF encoding and per-file progress/errors. `batch-runner.ts` boots a fresh isolated WASM worker for each sequential input, follows structural document identities and terminates it on success/failure/cancellation, preserving the open editor document, clipboard and history. Failed files are skipped; cancellation retains already published outputs and finishes a save in progress. Browser folder handles or downloads deliver binary exports; Electron's renderer-scoped folder grants publish synced temporary files atomically without overwriting existing files. Inputs are bounded to 128 MiB; output dither is disabled. Unit tests cover naming/formats, runner isolation/cleanup, cancellation and destination behavior; `e2e/batch.spec.ts` covers the real production-worker UI and native-CLI parity.
- [x] Native CLI (`packages/kernel/cmd/aae`, built alongside MCP by `just native-build`) imports through the Go codecs, runs recorded chains and exports WAV/FLAC/AIFF through the same engine. Repeated `--input` plus `--output-dir` adds sequential batches, suffix naming, destination collision/authorization preflight, fresh per-file engines, JSON result lines, failure isolation and `--fail-fast`. Explicit `--allow-write`, atomic publication and no overwrite without `--overwrite`; no file is exported after its chain fails. `batch_test.go` processes **100 files** through −16 LUFS normalization, both edge fades and 44.1 kHz/16-bit FLAC, comparing every encoded file with an independent sequence of the UI's kernel methods. Native Windows/macOS execution remains pending.
- [x] File-menu macro recording captures successful `edit.apply`, `process.start` and `effects.apply` requests at existing hook commit points; previews/cancelled/failed jobs are excluded. `AutomationDialog` imports/exports bounded version 1 JSON and replays through `chain-runner.ts`, the shared document lock, bounded kernel jobs and normal undo history, with progress, cancellation and completed-prefix errors. Optional operation-level `range: "document"` adapts to current file geometry on native/MCP/UI runners; scoped steps retain sample coordinates. Recorded paste resolves the current clipboard version, including after a recorded copy/cut. Noise profiles, extraction and loaded convolution IRs stop recording visibly; imported editor macros also reject these session-bound operations. Macro JSON must be exported for persistence; Undo/Redo, timeline and metadata actions are excluded. Replay also publishes authoritative clipboard metadata to the editor, enabling Paste immediately after a macro copy. Unit and production browser regressions cover exact gain/reverse playback-independent output, preview reuse without duplicate recording, JSON export, clipboard replay, structural identities, cancellation/commit races, invalid imports, caps and undoable failures. Electron verifies native recording menus, JSON disk export through scoped file grants, replay and undo.

**Validation (2026-10-04):** Full `just ci` passes formatting/lint/typechecks/tidy, native race/coverage, actual V8/WASM tests, both fuzz smoke checks, **962 frontend tests**, **145 browser tests**, **4 Pages tests**, **21 Electron tests** and the separate packaged Linux smoke. The normal desktop suite skips its packaged-only case, which passes in the dedicated packaged recipe. Nineteen new frontend unit tests cover batch orchestration/configuration, and four new Electron cases verify actual batch processing and folder-grant confinement/lifecycle. ABI 18 is unchanged; native Windows/macOS acceptance remains pending.

**UI batch acceptance (2026-10-04):** Four production browser cases pass, including **100 distinct stereo files** processed through −16 LUFS normalization, edge fades and 44.1 kHz/16-bit FLAC. All 100 outputs are **byte-for-byte identical** to the compiled native CLI using the same chain. Corrupt-input continuation, cancellation during an authoritative save, worker disposal and an actual download preserve the editor document, samples and history. Desktop regression processes two actual files into one selected folder with exact reverse samples; folder IPC tests cover traversal, destination symlinks, no overwrite, cleanup and expired grants. Desktop/narrow dialog screenshots have no horizontal overflow. Native Windows/macOS execution remains open.

---

## Phase 22: MCP Completion (drive the editor from an LLM) — OPEN

**Source:** Phase 14. Full tool, transport, safety and verification context is retained below.

**Goal:** Expose the kernel's operation model over the Model Context Protocol, so an LLM agent can inspect and edit audio with the same `Operation` values the UI uses — "normalize this to −16 LUFS, trim the silence at both ends and export 44.1 kHz/16-bit FLAC" as tool calls, not as DSP written by the model.

**Acceptance criterion:** An MCP client (Claude Code or Claude Desktop) connects to the server, opens a WAV, queries its statistics, applies a chain of operations, exports the result, and the output is sample-for-sample identical to running the same chain through the UI and through `cmd/aae`. Every mutating tool is undoable via the kernel's history.

**Depends on:** Phase 3 (processing infrastructure), Phase 5 (analysis), Phase 12's `Operation` serialization and native CLI — the MCP server is a third front-end over the same engine, next to the web UI and the CLI.

**First increment (2026-10-04):** `cmd/aae-mcp` and `internal/mcpserver` use the official Go MCP SDK v1.8.0 over stdio. Seventeen tools, independent kernel sessions, shared CLI chains, summary resources and workflow prompts are implemented; `[ ]` rows below retain their unfinished parts. See [setup, tool reference and limits](docs/mcp.md). No live desktop connection or HTTP listener is exposed.

**Inspection increment (2026-10-04):** `inspection.go` adds `select_seconds` (eighteen tools total), current waveform PNG and binary peak resources plus bounded query templates, using existing kernel selection/peak methods. SDK client regressions cover rounding/clamping, invalid ranges/masks, multi-channel/viewport peak geometry, live reads after edits, unchanged history and resource removal on close. ABI 18 is unchanged; silence detection needs kernel/upstream work and remains pending.

### Server

- [ ] `cmd/aae-mcp` now links `internal/engine` through the shared `internal/automation` runner, with official SDK stdio negotiation/cancellation and stderr-only diagnostics. Native stdio subprocess acceptance passes. HTTP transport remains pending; legacy SSE is deferred in favor of evaluating Streamable HTTP.
- [x] Up to eight path-opened documents have stable MCP routing IDs, separate kernel instances, selections, clipboards and undo histories. The adapter follows changing kernel publication IDs; close removes the document and its summary resource. Isolation/resource regressions in `internal/mcpserver/server_test.go`.
- [x] `internal/mcpserver` maps tool schemas and routing IDs to protocol payloads; `internal/automation` steps/commits/cancels kernel jobs. No DSP or sample storage in either adapter; binary import/export stays outside control JSON. Native-only files are excluded from JS builds; ABI 18 unchanged.
- [x] SDK tool schemas derive from Go input types; `list_operations` generates edit/process/effect parameter schemas directly from `internal/protocol`. Tests snapshot all 18 advertised input schemas, check ABI/version fields and dispatch recognition, and exercise the actual edit/process/effect/analysis/history paths.

### Tool surface

- [ ] **Read:** open/info/list, peak/RMS/DC/crest/clipped-sample statistics with available integrated LUFS, read-only clipping-region counts and bounded waveform/binary peak resources are implemented. Offline true peak and silence detection remain pending.
- [ ] **Edit:** sample-frame/channel-mask `select_range`, nearest-frame/clamped `select_seconds`, recorded UI `apply_operation` / `apply_chain`, undo/redo and history are implemented. Selection changes do not add history entries; each audio-changing step uses kernel history and structural/processing failures report the completed prefix. Cross-document extraction remains pending; chain payloads use existing operation names (`crop`, `mute`, `remove-dc`, etc.).
- [x] **Effects:** `list_effects` supplies paginated descriptors, parameters and presets with optional document-rate context; `apply_effect` and recorded `effects.apply` use private kernel jobs and commit one undo entry. Actual ringmod apply/dry-run/undo regression; convolution IR loading remains a separate follow-up.
- [ ] **Write:** export/save support native WAV/FLAC/AIFF, bit depth, float, selection scope, dither/noise shaping/seed and explicit overwrite. Rate conversion uses a preceding kernel `resample` operation. Save marks history clean only after successful publication; failed/read-only exports are tested. Dedicated `render_region` and browser-only codec exports remain pending.
- [x] **Resources:** current JSON summaries at `aae://documents/<id>/summary`, waveform PNG at `/waveform.png` and binary peaks at `/peaks` are removed on close, including their query templates. `inspection.go` draws min/max/RMS from kernel binary peaks without reading samples; resources reflect subsequent edits without mutating selection/history. Strict queries select channel/frame viewport, width/height or desired bucket count; dimensions, 32,768 PNG source records and the adapter's 16 MiB binary peak limit bound output. AAEP v1's 48-byte header preserves rate/channel/count/geometry before the unchanged peak buffer; no bulk JSON arrays. SDK client tests decode PNGs/header/peak records and compare them against the independent kernel response. See `docs/mcp.md` for dimensions and binary layout.
- [x] **Prompts:** `mastering_check`, `podcast_cleanup`, `batch_convert` guide schema discovery, inspection and explicit output choices. Client protocol tests discover/get prompts; prompts do not automatically execute work.

### Safety & ergonomics

- [x] Filesystem writes are disabled by default. Repeatable `--allow-write` opens existing roots through traversal-resistant `os.Root`; temporary/synced publication refuses existing files unless explicitly overwritten. Regression covers path escape, symlink escape, original preservation, explicit overwrite and temporary cleanup. Input paths use OS read permissions; in-memory edits remain enabled.
- [ ] Processing/effect dry runs evaluate the real private candidate and cancel it, preserving history; return geometry/peak and available normalization loudness fields. Structural edits, whole-chain dry runs and general output-LUFS prediction remain pending.
- [ ] Compact operation/chain results omit repeated annotation/history lists; documents are bounded to eight and effects paginate (default 10, maximum 20). Bulk audio/peaks never enter JSON arrays. Sensible numeric rounding and additional long-control-result pagination remain pending.
- [x] Tool errors preserve wrapped kernel messages plus inspection/retry guidance; unknown identities/methods/fields and unauthorized writes provide specific corrections. Partial-chain errors carry failed index, completed count/results and undo guidance. SDK validation errors remain standard MCP tool errors.

### Optional: the running editor as an MCP endpoint

- [ ] Evaluate exposing the *desktop app's* live session over MCP (Electron main process hosting the stdio/HTTP server, forwarding to the kernel worker), so an agent can edit the document the user is looking at, with the UI updating live
- [ ] If taken: a visible indicator and a per-session consent prompt while an agent is attached, and mutations land in the same undo stack as the user's

### Tests & docs

- [x] `internal/mcpserver/server_test.go` drives SDK client/server messages and a native stdio child: golden input schemas, open/statistics/gain+reverse/export, resources/prompts/descriptors, dry-run/effect/undo, session isolation, partial failures and save points. `internal/automation/files_test.go` covers file permissions, strict chains, bounds and cancellation/retry.
- [x] A gain/reverse chain via MCP, the `cmd/aae` runner and an independently driven UI protocol sequence produces byte-identical float WAV output; binary PCM is checked against Phase 3.2's reviewed IEEE-754 half-gain vectors. Interactive browser/Claude-host acceptance remains pending; this test verifies the shared operation path.
- [x] `docs/mcp.md` documents native build, official-source Claude Code/Desktop configuration examples, all tools, JSON chains/CLI, write permissions, cancellation/partial commits, resources/prompts and unfinished surface. README/AGENTS link the new native command. Actual interactive Claude configuration has not been tested.

**First-increment validation (2026-10-04):** full `just ci` passes (native race/coverage, actual V8/WASM, both fuzz smokes, formatting/lint/typechecks/tidy, 910 frontend, 134 browser, four Pages, 16 Electron and one packaged Linux smoke). The final native MCP/automation race tests and Go lint pass after schema-discovery/structural-save regressions were added. `just native-build`, `actionlint`, `check-deps` and `git diff --check` pass. A separate real stdio client drove the compiled `aae-mcp` binary through demo open/statistics → normalize to −16 LUFS → resample to 44.1 kHz → 16-bit FLAC export. The compiled `aae` binary ran the same chain: both outputs are identical, 176,400 stereo frames / 162,976 encoded bytes (SHA-256 `a74f893f5d46f0c36cb9b9bbceb8abe3ef561ff6d6ac340b6460dbdeeb48c8d5`). Native adapters are excluded from the WASM executable; raw kernel size remains 11,063,065 bytes.

**Inspection validation (2026-10-04):** Full `just ci` passes native race/coverage, actual V8/WASM and fuzz checks, formatting/lint/typechecks/tidy, 962 frontend, 145 browser, four Pages, 21 Electron tests and the packaged Linux smoke. Four new SDK client regressions verify seconds selection, physical channels, exact binary peak transport, current PNG/resources and bounded rendering over fragmented kernel storage. Eighteen advertised tool schemas match the golden; native-only image rendering leaves kernel ABI 18 unchanged. Interactive Claude host acceptance, HTTP/live desktop transport and remaining tool-surface items stay open.

---

## Phase 23: Dependency Licenses & Third-Party Notices — OPEN

**Source:** Phase S release prerequisite.

- [ ] Before the first public release: audit all Go and npm dependency licenses (MIT/BSD/Apache only for bundled code), and generate the third-party notices for the About dialog and installers

---

## Phase R: Review Remediation (2026-10-04)

**Source:** the full-repo review in [docs/REVIEW-2026-10-04.md](docs/REVIEW-2026-10-04.md) (overall 5.5/10, CI/CD 2/10). Findings, severities and `file:line` evidence live there; each item here is one actionable line. Keep the review IDs stable. R.1 established working CI, but its remaining lint/flake tasks stay open; R.5 is the next kernel implementation section, followed by R.8–R.10. Completed R.2–R.4/R.6–R.7 are summarized above.

### R.1 Make CI truthful (critical) — PARTIAL

- [x] Playwright install/real browser+Electron+packaged CI, green-main gates for Pages/releases, full-depth tag checks, actual V8/WASM CI, opt-in hardware timing, format/lint/type hooks and fail-closed dependency guards are implemented. PR #1 / `b1531cf` established the first green real CI run; reusable timed workflows followed in PR #2. Pitch bridge batching and MP3 panic recovery have regressions.
- [x] Electron relaunch-bounds regression now waits for applied geometry and the app's own persistence flush; 30/30 loaded Xvfb repeats pass.

- [ ] golangci:
  - restore revive's default rules
  - add errorlint and gosec
  - lint `cmd/kernel` with `GOOS=js GOARCH=wasm`
  - pin the action's version
  - add `timeout-minutes`
  - cache Bun and Playwright
  - pin third-party actions by SHA

  (2026-10-04) — partial: `ci.yml` is split into reusable `test-{format,lint,unit,fuzz,e2e}.yml` workflows, every job has a `timeout-minutes`, and `.github/actions/setup` pins Go, Node, Bun and just in one place (PR #2: 9 parallel jobs, 6m52s against 9m11s for the old four-job run). The other sub-items remain

- [ ] Pre-existing flake: `internal/effects/stream_test.go:181` (`AllocsPerRun`, "prepared auto-wah render+reset allocate 1") failed in 1 of 6 local `-race` runs. Find the stray allocation or make the measurement robust before it reddens CI

- [x] Browser CI run `37239688144` regressions (2026-10-05): `edits.spec.ts` now constructs shared silence exceeding the unified 3 GiB storage budget and checks the engine's memory-budget error; `export.spec.ts` checks centered PCM8 bytes from `wav v0.1.4`. `useProcess.open` captures the launcher before the document lock disables it and the lazy dialog loads; `finish` releases that lock before closing, and `ProcessDialog` restores focus after React's unmount commit. Preview stays in the processing phase until playback startup settles, preventing an enabled Apply click from being discarded while a preview is still pending. Unit regressions cover delayed playback, delayed lock release and conditional-unmount focus. Local `just e2e` passes all 146 browser tests without retries; all four Pages tests, 1,078 frontend unit tests, web lint/typechecks, formatting and production size budgets pass.
- [ ] Investigate the historical short-file EOF/device-clock snapshot concern from Phase 3.3: one parallel browser run reported frame 13 instead of 31; both the initial parallel and final serial 101-case sweeps passed the original assertions. The tentative snapshot-race explanation was not confirmed because the trace was cleaned. Product cursor code/assertions were unchanged; historical logs were `/tmp/phase33-browser.log` and `/tmp/phase33-transport.log` (temporary paths, not durable artifacts).

---

### R.5 Kernel structure and performance

- [ ] Split `Engine` (30 fields) into subsystems: document, transport, history, jobs, analysis, effects. Replace the 160-line dispatch switch and the two busy allow-lists with one method registry table that holds the decoder, handler and busy policy for each method
- [ ] Typed constants for operation, kind and state names instead of string literals
- [ ] Consistent error wrapping: `%w` everywhere and a method prefix on all upstream errors (`restoration.go`, `wav_metadata.go`). Make `decode` reject unknown fields
- [ ] Analysis and spectrogram steps limited by a time budget rather than 1024 frames or one FFT per call. Measure the round-trip count for a one-hour file (2026-10-04) — partial: pitch steps now spend 2^18 YIN units per call (151 instead of 9,422 round trips per second of audio). Statistics, clipping and spectrum steps are unchanged
- [ ] History byte accounting kept incrementally, without calling `countBytes()` on every push, prune or undo
- [ ] Tests — partial (2026-10-05): mono MP3 and multichannel LUFS export/reopen regressions pass in R.3; memory-budget boundaries pass in R.2. An actual one-hour FLAC import remains outstanding.

---

### R.8 Accessibility

- [ ] Keyboard cursor and selection on the waveform surface (arrow keys move the cursor, Shift extends the selection, Home/End jump)
- [ ] Selection edge handles as `role="slider"` with `aria-valuenow`, Shift/PageUp acceleration and debounced `selection.set`/seek RPCs

### R.9 Electron hardening

- [ ] Fuses via `@electron/fuses` at package time: RunAsNode off, `NODE_OPTIONS` off, inspect args off, embedded ASAR integrity on
- [ ] `session.setPermissionRequestHandler` and `setPermissionCheckHandler`: deny by default, and allow the microphone only for the app origin (needed before Phase 7)
- [ ] Protocol handler and preload:
  - wrap `decodeURIComponent` in the `try` (`main.ts:136`)
  - type the preload with `satisfies DesktopBridge`
  - an external-URL allowlist
  - a `will-redirect` guard
  - ignore `AAE_USER_DATA` in packaged builds
- [ ] Unit tests for `files.ts` (capability ids, symlink and size rejection), `shortcuts.ts` and the window-state validation

### R.10 Docs and process

**Compaction progress (2026-10-05):** Completed implementation now has concise summaries, unfinished gates have separate follow-up phases, and historical counts/versions are identified as historical. The original audit below remains open: deeper claim verification, benchmark artifact extraction, companion-document updates and release/process work are still required. Old phase references map through the roadmap table above.

- [ ] Correct PLAN's verification claims (2026-10-04 — partial: the CI e2e claims in Phases 0.5 and 9 are corrected):
  - CI e2e in Phases 0.5 and 9
  - the spectrogram-gate contradiction between Phases 5 and 8
  - "ABI v10" in U.5
  - the stale test counts
  - reconcile phase status (Phase 3 open while 4/5 are COMPLETE)
- [ ] Move timing logs and benchmark reports out of PLAN.md into `docs/benchmarks/`. Plan items state outcome, files and regression test in one or two lines
- [ ] Update the AGENTS.md layout table (`audiobuf`, `ops`, `history`, `process`, `effects`, `buildinfo`, `docs/`). Bring CHANGELOG.md up to date
- [ ] Work on branches with PRs and a required green CI. Keep commits small with bodies. Tag `v0.1.0` once CI is green, which also gives `check-unreleased` something to check. Add a CI badge and a screenshot to the README

---

## Phase S: Quality, Testing, Build & Deployment (cross-cutting)

### Testing strategy

- **Kernel (Go):** table-driven unit tests; golden vectors for every process and effect (generated once, reviewed, checked in); property tests for the block model; fuzzing for every decoder (`go test -fuzz` smoke job in CI, as Agogo-Web does for PSD)
- **Coverage targets:** ≥ 90 % for `internal/audiobuf` and the processing packages; ≥ 80 % for the kernel overall
- **Frontend:** Vitest for logic (ring buffer, RPC, command registry, coordinate mapping); React Testing Library for complex components
- **End-to-end:** Playwright for browser and Electron. Audio-correctness e2e: render through an `OfflineAudioContext`-driven harness and compare with the kernel's offline render.
- **Performance:** kernel benchmarks with tracked allocs/op; e2e timing budgets for open, edit and peak requests

### Build & release

- Versioning: SemVer `v0.x` until the waveform editor (Phases 1–6 plus remaining metadata/persistence in Phases 16–17) is complete; the CHANGELOG uses the Keep a Changelog format
- An application, not a library: `gorelease` API checks do not apply, but the family's dependency rules do. `just check-deps` must be green before a release, and a deliberately deferred sibling bump is recorded here.
- Upstream algo-dsp work flows up the dependency graph: implement in algo-dsp → tag via `just tag-release` there → bump here. Never pin a pseudo-version.

### Deployment & security headers

- GitHub Pages via `pages.yml` with `VITE_BASE=/<repo>/`; COOP/COEP via `coi-serviceworker.js` (publishing and its verification: Phase 13)
- Electron: COOP/COEP/CSP from the `app://` handler; `contextIsolation`, `sandbox`, no `nodeIntegration`; navigation locked to the app

**License audit:** first-public-release prerequisite moved intact to Phase 23.

---

## Deferred / Later

- VST3/CLAP plugin hosting (desktop only, via a native helper process)
- MIDI input for transport control
- Video track for post-production sync
- Collaborative editing
- Scripting API (JS or Lua) on top of the operation model
- Localization (UI strings are English for now)
