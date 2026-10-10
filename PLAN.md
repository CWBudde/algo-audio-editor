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

**How to read this plan:** Phases 0–15 are complete for their stated scope; their summaries describe what exists today. Every unfinished item lives in the open phases 16–35 (Phase 22 moved to *Deferred*); work them in the **critical-path order** below, not by number. Feature guides live in [`docs/`](docs/); dated measurements and validation scope live in [`docs/benchmarks/`](docs/benchmarks/README.md). The [historical roadmap at `9de516f`](https://github.com/cwbudde/algo-audio-editor/blob/9de516f/PLAN.md) keeps the full implementation narrative. Testing strategy is in [docs/testing.md](docs/testing.md); release rules are in [docs/releasing.md](docs/releasing.md). The latest whole-repository review is [docs/REVIEW-2026-10-07.md](docs/REVIEW-2026-10-07.md); Phases 29–33 and the changed acceptance criteria below come from it.

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
| 15 Visual design | App-icon palette shared by DOM and canvas, adaptive waveform lanes, vertical waveform zoom (1×–64×), frequency rulers and spectrogram readouts, analysis dock, restyled dialogs and panels. Effect editor redesign: consolidated Filter/Weighting dialogs with kernel frequency charts, compact square-plot dynamics editors with Feedforward/Feedback topology, per-band multiband rows and Dynamic EQ band rows with kernel band transfer graphs (`algo-dsp v0.12.1`–`v0.12.4`). The last five editor commits skipped full checks; Phase 29 restores the gate. | [visual design](docs/visual-design.md) | 24 (part) |

---

## Open phases

Original phase numbers are noted per phase; dated reports in `docs/benchmarks/` and older docs use them.

### Critical path to v0.1.0

`v0.1.0` is a **development release**: the web build plus unsigned Linux AppImage and Windows/macOS zip artifacts, labelled as development builds (decided 2026-10-08). Signed installers and installed-update acceptance (Phase 19) gate **1.0**, not `v0.1.0`. Work in this order; new effect-editor polish waits until the tag, and only bug fixes go in before then.

1. **Phase 29**: green `main` and gate discipline (stop-the-line).
2. **Phase 30**: data safety and v0.1 basics.
3. **Phase 18**: autosave and crash recovery (`.aaep` may follow the tag).
4. **Phase 17**: MP3 and FLAC metadata.
5. **Phase 27**: property-based license policy passing.
6. **Phase 31**: kernel and playback robustness.
7. **Phase 28**: flakes fixed or quarantined, then tag `v0.1.0`.

After the tag: Phases 32, 33, 34, 35 and 16, then 19 (1.0 gate), 24, 25, 26, with 20, 21 and 23 as non-blocking acceptance work.

### Phase 29: Green Main & Gate Discipline

*New (review 2026-10-07).* **Acceptance:** CI is green on the head of `main` and on each of the next 10 pushes. `just test` passes on macOS. `just check` fails locally on everything CI's lint job fails on.

- [x] Fix forward the failures that have kept `main` red since `d1c8caf`: import sort, two justified `useExhaustiveDependencies` reset effects, and stale `lane-layout`/`waveform-view` expectations after `c8ebc6e`'s header and guide changes. Local `just check` passes on macOS; the first remote run after merging confirms it.
  - The Electron `analysis…progressive spectrogram` timeout is classified as a flake: it is 1 failure in 26 Electron runs, it stalls in the cold first-launch `load()` (a `doc.info` that never answered), not in the spectrogram, and `d1c8caf` changed only tooling. If it recurs, capture an Electron context trace and console output in `apps/desktop/e2e/launch.ts` before changing any timing. The probe's 5 s per-request timer currently equals the whole poll budget.
- [x] **macOS write-root bug:** `NewFilePolicy` resolves roots with `EvalSymlinks`, but `destination()` only applies `filepath.Abs` (`internal/automation/files.go`). On macOS, `--allow-write /tmp` therefore rejects `/tmp/x.wav`. Fix: canonicalize the destination's existing parent directory before the `Rel` check, keeping `os.Root` confinement. Add a symlinked-root regression test. This fixes 4 failing tests on macOS: three in automation and `TestMCPCLIAndUIProtocolParity`.
- [x] Add a `macos-latest` and `windows-latest` `go test` job (2026-10-08) — the `go-native` matrix in `test-unit.yml` passed on both in PR #3 (CI run 37819657110), the first hosted Windows run, including the automation write-root tests.
- [x] Make the browser and Electron e2e suites pass on macOS (2026-10-08) — fixtures press `ControlOrMeta`; only the deliberate Ctrl probe in `commands.spec.ts`, the Linux/Windows-only Ctrl+Y redo and Ctrl+wheel zoom stay `Control`. Also fixed:
  - Stale effects/vertical-zoom expectations after the editor redesign and `c8ebc6e`'s time guides; these failed on Linux too.
  - macOS lifecycle and `/private/var` temp paths in `native.spec.ts`, Chromium's `system-ui` font serialization, and a `metadata.spec` undo race.
  - No app bugs found, no `fixme`, no limits relaxed. On macOS `just e2e` gives 172 passed (baseline: 56 failed); `just e2e-desktop` gives 24 passed and 1 skipped (baseline: 8 failed).
- [x] Re-cover the consolidated filter variants (2026-10-08) — a browser e2e test reaches every `filter-*` and weighting variant through the Filter "Type"/"Family" and "Weighting" selects, with preview, one undoable apply and distinct kernel output per path. It found that choosing the Moog family kept standard-filter parameters (`stopbandDB`), so the kernel rejected preview and apply. The dialog now sends only the parameters the node's own type declares (covered by a unit test). `just e2e`: 173 passed.
- [x] Run E2E on pull requests that touch `apps/editor-web/src`, `apps/desktop/src` or the e2e specs, not only on release PRs and the `e2e` label. Three editor-redesign commits left five stale specs unnoticed. (2026-10-09) — a `changes` job in `ci.yml` pipes the PR's file list into `scripts/e2e-changed-paths.mjs` (both `src` and `e2e` directories, the Playwright configs, `test-e2e.yml`), and E2E also runs when it reports `run=true`. `just test-scripts` covers the path rules; on PR #4 hosted CI printed `run=false` for the kernel/CI-only commits and `run=true` once `apps/desktop/e2e/launch.ts` changed (run 37857307818).
- [x] Align local hooks with CI:
  - `just lint-web` runs `biome ci`, as CI does, instead of `biome lint`.
  - `just check` warns when the lefthook hooks are not installed.
  - Add a `pre-push` hook (`biome ci` plus related Vitest).
- [x] Process rule in AGENTS.md: never push onto a red `main`. Interactive design sessions work on a branch and merge only when green.
- [ ] Configure required CI checks and branch protection for `main`. Keep an explicit admin bypass for the authorized direct-main workflow. The branch protection API currently reports `Branch not protected`; this item moved here from Phase 28.
- [x] Enforce the per-package coverage targets in [testing](docs/testing.md) (2026-10-08) — `scripts/check-coverage.mjs` (`just check-coverage`, in `check`/`ci` and the CI Go job) fails below 90% for `audiobuf`, `process` and `effects` and below 80% for the kernel total, and writes the table to the job summary. New `process` tests for the `MaterializedBytes` reservations and for verifying unity-gain loudness candidates raise it from 88.8% to 90.3%. Local run: total 88.1%, audiobuf 97.7%, effects 91.2%. `automation` (77.5%) has no gate yet.
- [x] Surface Playwright `flaky` (retried) results in the CI step summary, and record each one in Phase 28 (2026-10-08) — the browser and Pages configs write JSON reports in CI, and `scripts/playwright-flaky-summary.mjs` (an `if: always()` step in `test-e2e.yml`) lists the flaky tests in the job summary and as warning annotations. Checked against a real Playwright report with a retry-passed test and by `just test-scripts`; the first hosted run is still to come. The Electron suite has no retries, so its flakes still fail the job.
- [ ] Pin local tools as CI does:
  - Go `tool` directives for gofumpt, gci and golangci-lint.
  - `"packageManager": "bun@1.4.2"`. The root `package.json` is a hashed license-inventory input, so add the pin together with a `just licenses` run on Linux; regenerating on macOS drops the Electron binary evidence.
  - `dep-drift.yml` uses `go.mod`'s toolchain instead of `stable`.
  - (2026-10-09) — partial: gofumpt v0.10.0, gci v0.14.0 and golangci-lint v2.12.2 are `tool` directives in a separate `tools/go.mod` (outside the kernel's license inputs), run through `scripts/go-tool.sh` by treefmt, lefthook and `just lint-go`; CI's lint job reads golangci-lint's version from it, and `dep-drift.yml` uses `packages/kernel/go.mod`'s toolchain. Remaining: the Bun `packageManager` pin, together with a Linux `just licenses` run.
- [x] Protocol parity v2 (2026-10-08):
  - Compare field kind, optionality (`omitempty` vs `?`) and nullability (pointer vs `| null`), not only names.
  - Fail when the schema hash changes without a `protocol.Version` / `PROTOCOL_VERSION` bump.
  - Extend the shared Go-marshals/TS-parses golden files beyond process jobs.
  - Done: `scripts/protocol-schema.go` emits each field's kind, optionality and nullability plus a schema hash. `protocol-parity.test.ts` compares them; its two-entry `tsDiffers` allowlist fails once an entry is stale. `TestSchemaHashPinsVersion` pins the hash to `protocol.Version` in `testdata/schema-hash.json`; re-pin with `-update-schema-hash`. New document, analysis and effects golden files are checked on both sides. Scratch edits proved both checks: an optional `TimelineMarker.name` fails parity, and a new Go field without a version bump fails the hash pin.
- [x] `engine/binary_document.go:29` passes `metadata.Tags` unguarded, so a nil map would send `"tags": null` where TypeScript declares `Record<string, string>`. `metadata.go` already guards this. Nil slices and maps are outside the pointer-only nullability check. (2026-10-09) — `exportCandidate` now sends `{}` for the nil tag map that FLAC/AIFF/MP3 imports (`installPCM`) leave; `TestExportCandidateUntaggedSendsEmptyTags` failed with `tags = null` before the guard. The parity check still does not cover nil slices and maps in general.

### Phase 30: Data Safety & v0.1 Basics

*New (review 2026-10-07).* **Acceptance:** closing a tab or window with unsaved changes asks first. File → New, Preferences, the shortcut list and Copy diagnostics work in the browser and Electron, each covered by e2e.

- [x] Browser `beforeunload` guard while any document is dirty. Electron already has a guarded close.
- [x] Browser open/import over a dirty document asks first. `confirmReplace` in `use-document.ts` runs only in Electron. (2026-10-09) — `importFile` now checks `history.dirty` on every platform and asks through Electron's native dialog or the browser's `confirm` with the same wording, so Open, drag-and-drop and the demo are covered. `use-document` unit tests cover declined, accepted, clean and desktop paths. `unsaved-changes.spec.ts` dismisses the prompt (document and history kept) and accepts it (new document opens). E2E helpers that replace edited documents now accept the prompt explicitly (`openDiscarding`, `load`).
- [ ] File → New: chosen sample rate, channel count and optional silent length. `file.new` is currently disabled in `lib/commands.ts`.
- [ ] Minimal persisted preferences: default export format and dither, time format, snapping. There is currently no settings store.
- [x] Help → Keyboard shortcuts, generated from the command registry. Help → Copy diagnostics, reusing About's diagnostics. (2026-10-09) — `commandShortcuts()` lists every binding the key matcher accepts, per platform, grouped by menu, and `ShortcutsDialog` renders it. `lib/diagnostics.ts` provides the About dialog's facts and their plain-text form. Copying uses `navigator.clipboard` in the browser and, in Electron, a new `copyText` preload API backed by the main-process clipboard: menu commands carry no user activation, and the permission policy grants only audio. Both items reach Electron's native menu through `COMMAND_MENUS`. Covered by unit tests and by `e2e/help.spec.ts` in the browser (clipboard read back) and in Electron (native menu, main-process write captured).
- [ ] Export: default TPDF dither for integer depths ≤16 bits. Normalization warns when the output sample/true peak exceeds 0 dBFS. Offer an optional true-peak ceiling for LUFS normalization.
- [ ] Record the MP3-export decision in [codecs](docs/codecs.md#lossy-export), under the Phase 27 policy.

### Phase 16: Processing & Playback Performance Acceptance

*Originally Phase 15. Gate replaced 2026-10-08.* **Acceptance** on the reference laptop, median of 5 runs:
- Every O(n) process runs at ≥20× real time on a ten-minute stereo file.
- Resampling runs at ≥3× real time (Fast/Balanced) and ≥1× (Best).
- The UI never stalls for more than 50 ms.
- Progress updates arrive at least every 250 ms.
- Cancel takes effect within 200 ms.
- Spectrogram rendering never blocks playback or drops samples.

- [ ] Record the reference laptop (CPU, RAM, OS, browser and version) in [testing](docs/testing.md); every timing gate in this plan refers to it.
- [ ] Rework `process-benchmark.spec.ts` to measure throughput and responsiveness against the gates above. The previous absolute "<1 s per process including paint" sweep (last result: 17 pass / 15 fail) stays as historical evidence only. [Sweeps and reproduction](docs/benchmarks/processing-2026-10-03.md).
- [ ] CI relative regression guard: kernel benchmarks fail when they regress more than ±15% against a stored baseline, in the style of algo-dsp's `benchguard`. This replaces the former Phase 25 benchmark item.
- [ ] Profile and explain the historical `spectrogram-playback.spec.ts` underruns (Phase 8 and its baseline failed; Phase 5 and R.5 passed), then rerun without relaxing timing or underrun limits. [Runs](docs/benchmarks/spectrogram-playback-2026-10-04-05.md).

### Phase 17: MP3 & FLAC Metadata

*Originally Phase 16.* **Acceptance:** import/preserve MP3 ID3 and round-trip mapped FLAC Vorbis comments with matching metadata fields and unchanged audio/save-state behavior.

- [ ] MP3 ID3 import/preservation and FLAC Vorbis comment import/export mapping, with matching metadata editor fields. Create dedicated upstream repositories only if the existing tagged codecs are insufficient. Current limits are in [codecs](docs/codecs.md#wav-metadata).

### Phase 18: Projects, Autosave & Recent Files

*Originally Phase 17.* **Acceptance:** after a killed tab or Electron process, edits older than 5 s survive, and recovering a one-hour stereo document takes ≤10 s. Autosave and recovery are part of `v0.1.0`; the `.aaep` container and its association may follow the tag.

- [ ] OPFS-backed incremental autosave of dirty documents (only new blocks written) and crash recovery on startup.
- [ ] `.aaep` project: a zip-like container of the autosave block store, optional history, markers and view state.
- [ ] Application-owned recent files (browser: OPFS handles; desktop: native paths). OS recent-document acknowledgement already exists.
- [ ] `.aaep` desktop file association.

### Phase 31: Kernel & Playback Robustness

*New (review 2026-10-07).* **Acceptance:** each item has a regression test. An injected panic or effect error during playback leaves documents and history intact and shows an error in the UI.

- [ ] Recover panics in the `render`, `copyMeters` and `takeData` bridge calls (`cmd/kernel/main.go`); only `Call` recovers today. A recovered panic cancels process and analysis jobs and stops the transport.
- [ ] Report why playback stopped instead of treating every stop as end of file. Today an effect-stream error, a non-finite sample or a resampler error each set `playing=false`, and the UI shows a normal end (`transport.go`, `transport_resample.go`).
- [ ] MP3 gapless: when LAME/Xing data is inconsistent, decode untrimmed instead of failing the import. Cases: `padding < 529` (`mp3.go:111`) and a Xing frame count that differs from the decoded count, for example a stale header on a cut file. Add a fixture for each.
- [ ] WAV: treat a zero-size `data` chunk as "runs to EOF" only for streamed or unknown RIFF sizes. Today an empty `data` chunk followed by `LIST`/`cue ` imports those chunk bytes as audio (`wav.go`).
- [ ] Size the ring and the preview horizon by sample rate:
  - The ring is 8192 frames, which is only 42.7 ms at 192 kHz. Use about 170 ms in frames (`audio-engine.ts`, `stream-pump.ts`).
  - The 16 ms effect-preview horizon grows adaptively after an underrun.
- [ ] Align meters and live spectrum to the audible frame through a snapshot queue keyed by output frame. They currently lead playback by the ring depth (~170 ms at 48 kHz).
- [ ] Selection spectrum: a budgeted Welch average over all hop-spaced frames of the selection. It currently samples only `averaging` windows (`analysis.go`), which is 0.06% of a ten-minute selection. `averaging` stays as a cap only for the live spectrum.
- [ ] Automation and desktop inputs:
  - One memory budget per MCP session, not 8 × 3 GiB engines.
  - FIFO-safe `ReadFile`.
  - Reject UNC and `\\?\` paths in Electron argv `enqueue`.
  - Fall back to exclusive create plus rename when hard links are unsupported (exFAT/SMB) in desktop folder writes.
- [ ] Structure:
  - Split `applyEdit` (171 lines) into per-operation plan structs.
  - Split `startAnalysis` (163 lines) and wrap its raw upstream errors; fix the "must be20Hz" message.
  - Remove the identity `cloneEditor`.
  - Reduce the remaining functions over 100 lines (`convertClipboard`, `decodeWAVTimeline`, `inspectWAV`, `exportDocument`, `decodeMP3`).
- [ ] Downmix to `destination.maxChannelCount` in the kernel when the document has more channels than the output device. 3-, 5- and 8-channel files currently drop channels on stereo devices. Replace the cyclic clipboard 5.1→stereo fold with a BS.775 matrix, upstream first.

### Phase 32: Effect Application Quality

*New (review 2026-10-07). Upstream-first in algo-dsp `effectchain` where applicable.* **Acceptance:**
- Applying a +12 dB low shelf to a selection that starts mid-signal leaves no boundary step above −60 dBFS.
- Reverb and delay tails can be kept.
- Preview started mid-selection matches Apply after the pre-roll.
- Structural parameter changes during preview cause no discontinuity above −60 dBFS.

- [ ] Equal-power crossfade at both selection edges, plus an optional tail: either extend the selection or mix the tail into the following audio. Today wet output switches hard at the edges and tails are cut at `selected.End` (`effects/stream.go`).
- [ ] Pre-roll from `max(selection.Start, frame − preroll)` in `Prime`, bounded by a time budget, so seeks, loops and mid-selection starts match Apply.
- [ ] Crossfade old and new streams for one or two quanta on updates that can't be applied in place. Ramp wet/mix changes within a quantum.
- [ ] Response graphs request ≥1024 points or include each band's centre frequency, so narrow notches (Q 30) render at their real depth.

### Phase 33: Frontend Structure

*New (review 2026-10-07). No behaviour change.* **Acceptance:**
- No hook or component exceeds 500 lines.
- `AppLayout` does not re-render on unrelated dialog flags (Profiler test).
- At most one latest-only `effects.response` request per dialog is in flight.

- [ ] Split `useAppController` (751 lines, about 55 returned fields) into `usePlayback`, `useDialogState` and the remaining orchestration. Pass `AppLayout` slices or contexts instead of the whole controller.
- [ ] Add a `useEffectResponse` hook with a shared latest-only queue and bounds-checked decoding. Today each `EffectCurve` and band graph sends its own RPC on every parameter change, and the `DataView` length is unchecked (`effect-parameters.tsx`).
- [ ] Move per-effect rules (filter order and oversampling, Moog Q clamps, `/gain/i` and `/freq/i` id matching) out of `EffectParameters` into descriptor-driven `lib/` modules.
- [ ] Add a generic latest/epoch/session primitive to replace the hand-written copies in `use-edit`, `use-history`, `use-document`, `use-process`, `use-effects` and `use-selection`.
- [ ] Extract `useWaveformPrefs` from `waveform-view.tsx` (1322 lines). Give spectral selection a single owner; it currently lives both in the view and in the controller.
- [ ] Accessibility and input:
  - `dynamics-graph` gets an interactive role instead of a focusable `role="img"`.
  - Add a keyboard path for `filter-response-graph`.
  - EQ handle wheel requires focus or a modifier, so it doesn't hijack dialog scrolling.
  - No ref writes during render.
- [ ] Unit tests for the `kernel-call.ts`/worker boundary and the graphic EQ and filter response graphs. Replace path-`d` assertions with behaviour (keyboard and wheel value changes).
- [ ] Runtime guards for the most complex RPC results at the worker boundary, replacing unchecked `as` casts (`kernel/client.ts`, `kernel-call.ts`).

### Phase 34: Speech Generation

*New (2026-10-09).* **Process → Generate speech…** speaks text with [go-pocket-tts](https://github.com/cwbudde/go-pocket-tts) and places it like a generator. Design: [spec](docs/superpowers/specs/2026-10-09-speech-generation-design.md); guide: [speech](docs/speech.md). **Acceptance:** the dialog speaks every catalog model in Chromium, Firefox and Electron from a cold cache, and a recorded macro replays to the same samples on the same platform.

- [x] Kernel `audio` generator for `process.start` with binary PCM, ABI 19; `speech.generate` chain step; `aae speech list|download`, `--speech-models` for `aae` and `aae-mcp`, MCP `generate_speech`/`list_speech_models`; `speech.wasm` bridge (2026-10-09). Native CLI and MCP export byte-identical speech for a seed (opt-in `AAE_SPEECH_MODELS` tests).
- [x] Speech worker, dialog, macro recording/replay and Electron model downloads (2026-10-09).
- [x] Tag go-pocket-tts `v0.2.0` (its public-API PR) and replace the pseudo-version in `packages/kernel/go.mod`; rerun `just licenses` (2026-10-09).
- [ ] `just check-deps` stops at `github.com/cwbudde/go-call-pocket-tts`, which go-pocket-tts requires for its CLI backend at an untagged pseudo-version (never linked here). Tag it and release go-pocket-tts with that tag.
- [ ] Browser acceptance with real models: cold download, progress, cancel during download and synthesis, 24-layer memory on the reference laptop. Record timings in `docs/benchmarks/`.
- [ ] Live Pages check that Hugging Face downloads pass the isolation service worker in Chromium, Firefox and Safari.

### Phase 35: Music Transcription

*New (2026-10-10).* **Analysis → Transcription** turns the selection into notes with a pure-Go port of Spotify's [basic-pitch](https://github.com/spotify/basic-pitch) from [algo-transcribe](https://github.com/cwbudde/algo-transcribe) (Apache-2.0, weights embedded, no model download). Notes appear as a piano-roll overlay and export as MIDI or CSV; the native CLI and MCP server expose the same engine. Prerequisites, released upstream first: `github.com/cwbudde/midi` with `Track.PitchBend`, `algo-dsp` with `dsp/cqt` (its Phase 46) and `algo-transcribe` v0.1.0. Transcription runs inside `kernel.wasm` as a resumable analysis kind; if it breaks the 12 MiB raw / 3 MiB gzip budget, it moves to a lazily loaded `transcribe.wasm` following the speech pattern. **Acceptance:** a piano and a vocal recording transcribe in Chromium, Firefox and Electron with progress and cancel while playback keeps running; the exported MIDI matches `aae transcribe` byte for byte; the realtime factor on the reference laptop is recorded in `docs/benchmarks/`.

- [ ] 35.1 `transcription-kernel` — Add the `transcription` analysis kind to the kernel. Bump `github.com/cwbudde/algo-transcribe`, `github.com/cwbudde/algo-dsp` and `github.com/cwbudde/midi` to their latest tags (no pseudo-versions; `just check-deps` must pass). Protocol, Go and TypeScript in one commit (`packages/kernel/internal/protocol/{analysis.go,names.go}`, `packages/protocol/src/index.ts`): `AnalysisTranscription`, transcription options on `AnalysisStartParams` (onset and frame thresholds, minimum note length in ms, minimum and maximum pitch, melodia trick, pitch bends; each option is optional, so omission selects the basic-pitch default while an explicit value, including `false` and `0`, is kept and range-checked: pointer fields with `omitempty` in Go, optional fields in TypeScript), the methods `transcription.notes` (re-run note creation on a ready job with new options, no inference) and `transcription.export` (format `mid` or `csv`, bytes through `takeData`), the operation-chain method name `analysis.transcribe` with its params (selection plus the same options) defined like `speech.generate`, a `protocol.Version`/`PROTOCOL_VERSION` bump, and the schema pin `internal/protocol/testdata/schema-hash.json` rewritten with `go test ./internal/protocol -run '^TestSchemaHashPinsVersion$' -update-schema-hash` (checked by `schema_hash_test.go` and `protocol-parity.test.ts`). Engine (`internal/engine/transcription.go` plus hooks in `analysis.go`, following `stepPitch` and the analysis job lifecycle): mix the selected channels down to mono in Go, stream-resample to 22050 Hz with algo-dsp, and drive `basicpitch.Job` from `stepUnit` under the existing 2 ms budget so playback keeps rendering; reserve memory for the cached activations through `internal/memory` and refuse with a clear error above the cap; a state change makes the job stale like other analyses. A ready transcription leaves the single analysis slot as a retained per-document result that keeps its activation reservation, so other analysis kinds can run meanwhile: `transcription.notes`, `transcription.export` and `analysis.commit` address it by job id, a new transcription replaces it, a state change makes it stale and `analysis.cancel` releases it. Results reach the frontend as a binary note table (start and end in document seconds, MIDI pitch, amplitude, bend offset and count as float64) plus a float32 bend pool, described in `protocol` like the other binary layouts. Extend `commitAnalysis` so a ready transcription commits its notes as regions named by pitch (for example `C#4`) in one undoable edit, failing clearly above `MaxAnchors`. Run `just licenses` for the new modules and review the regenerated inventory and notices in the same PR, so `just check-licenses` (part of `just check` and CI) stays green. Tests: table-driven engine tests (defaults, omitted versus explicit `false`/`0` options, stale state, cancel, retention while another analysis runs, release, renote, export, commit), the js/wasm bridge test (`just test-go-wasm`), and the web budget check (`scripts/check-web-budget.mjs` via the build) with the measured `kernel.wasm` growth stated in the PR body.
- [ ] 35.2 `transcription-cli-mcp` — Expose transcription natively. `aae transcribe <input> --out <file.mid|file.csv|file.json> [--onset-threshold … --frame-threshold … --min-note-ms … --min-pitch … --max-pitch … --no-melodia --no-pitch-bends]` in `internal/automation`, plus the `analysis.transcribe` operation-chain step from 35.1. The step commits the notes as regions exactly like Add notes as regions (one undoable edit whose `EditResult` is the step result) and stays a version 1 chain method like `speech.generate`: accept it in both validators (`internal/automation/runner.go`, `apps/editor-web/src/lib/operation-chain.ts`) and run it through `analysis.start`, stepping and `analysis.commit` instead of the process/effects job path in both runners (`internal/automation/runner.go`, `apps/editor-web/src/kernel/chain-runner.ts`), with cancellation releasing the analysis. An MCP tool `transcribe_audio` in `internal/mcpserver` that returns a note list capped like other tool outputs and optionally writes `.mid`/`.csv` under the existing write-root permission policy, with dry-run support. Tests in the style of the speech and analysis tools, including chain validation and replay on both runners; native CLI, MCP and editor export must produce byte-identical MIDI for the same input and options. Update `docs/mcp.md` (tool list, chain step) and the CLI help.
- [ ] 35.3 `transcription-dialog` — Add Transcription to the Analysis dialog (`components/analysis-dialog.tsx`, `hooks/use-analysis-dialog.ts`, `kernel/analysis-runner.ts` including `validAnalysisProgress`, `lib/analysis-settings.ts`). Settings for every option with the basic-pitch defaults and persisted like other analysis settings; progress and cancel through the existing analysis queue, which keeps a ready transcription instead of cancelling it in its `finally` (today only clipping survives, `kernel/analysis-queue.ts`) and releases it with `analysis.cancel` once the result is discarded, replaced or stale; after the job is ready, changing thresholds re-notes live through `transcription.notes` without re-running inference. Show a note table (time, note name, duration, velocity) and a compact piano-roll preview drawn from the kernel's note table (draw only, no sample processing in JS). Actions: Export MIDI… and Export CSV… through the platform save path (browser download and Electron native dialog), and Add notes as regions, which records an `analysis.transcribe` step with the current options while a macro is recording (its runners come from 35.2). Register the commands in `lib/commands.ts` (palette and menu). Tests: Vitest for the binary note-table decoding, the settings and the queue retention and release, Playwright e2e (`just e2e`) that transcribes a generated chord, re-thresholds, exports MIDI and adds regions with undo.
- [ ] 35.4 `piano-roll-overlay` — Draw the transcription as a piano-roll overlay on the waveform and spectrogram views: notes as rectangles on a pitch axis (shared with the frequency ruler where the spectrogram is shown) with velocity shading and pitch-bend curves, synchronized with zoom, scroll and vertical zoom, with a hover tooltip (note name, start, duration, velocity). A View-menu toggle persisted in preferences; the overlay follows the current transcription result and clears when it becomes stale. Canvas drawing only, from the kernel's note table; no allocation per frame in the draw loop. Follow `docs/visual-design.md` for colours in light and dark themes. Tests: Vitest for coordinate mapping, Playwright e2e for the toggle, zoom sync and tooltip, plus screenshots for the visual check in the PR body.
- [ ] 35.5 `transcription-docs` — Close the phase out. Write `docs/transcription.md` (usage in the editor, CLI and MCP; options and their effect; accuracy caveats such as polyphony density, drums and resampling differences from the Python reference; Spotify Apache-2.0 credit), link it from README and `docs/mcp.md`, confirm `just check-licenses` and `just check-license-policy` (the inventory was regenerated in 35.1; rerun `just licenses` only if dependencies changed since), measure the browser realtime factor on the reference laptop (Chromium and Firefox, with and without playback running) into `docs/benchmarks/transcription-<date>.md`, update the AGENTS.md layout table if new packages appeared, and collapse Phase 35 into the Completed table once every item and the acceptance criteria are met.

### Phase 19: Desktop Release & Installed Platform Acceptance (1.0 gate)

*Originally Phases 19 and 21.* **Acceptance:** signed installers for Linux (AppImage + deb), Windows (NSIS) and macOS (dmg) build in CI; file associations open documents and auto-update works on all three. This gates **1.0**, not the `v0.1.0` development release. Credentials and platform limits: [desktop](docs/desktop.md#updates-and-publishing).

- [ ] Configure signing credentials and the Linux package signature policy; verify signed/notarized installers in CI and installation/file associations on all target OSes.
- [ ] Set `win.signtoolOptions.publisherName` so electron-updater verifies the Authenticode publisher. Confirm that `app-update.yml` carries it.
- [ ] Place the web build inside the ASAR integrity boundary, or verify a hash manifest in `app-protocol.ts`. Renderer JS and WASM currently sit in user-writable `extraResources`.
- [ ] Verify a real installed old-version → new-version GitHub update on Linux, Windows and macOS (current tests stub the feed/installer).
- [ ] Verify Windows/macOS installer icons and installed audio associations (Linux already passes).
- [ ] Verify installed Windows/macOS packaged notices (`resources/licenses`) and typography.
- [ ] Run the native CLI/batch acceptance on Windows and macOS (Linux, UI 100-file parity and Electron folder processing pass).

### Phase 20: Hosting Cache & Browser Acceptance

*Originally Phase 20. Non-blocking for `v0.1.0`.* **Acceptance:** the public editor loads from a cold cache, reports `crossOriginIsolated === true`, imports a WAV, plays without underruns and exports it again, verified by live Playwright CI. Limits: [web deployment](docs/web-deployment.md).

- [ ] Strict hosting cache policy: GitHub Pages controls CDN headers (observed `max-age=600`), so never-cached HTML/worker and long-term immutable caching are not achieved; stale CDN HTML can still reference removed assets. Requires a host with header control or an equivalent mitigation.
- [ ] Add a meta Content-Security-Policy to the Pages build that mirrors `app-protocol.ts`, minus `frame-ancestors`. Pages cannot send CSP headers.
- [ ] Firefox/Safari acceptance and native AAC encode acceptance (Chromium is the tested reference; Linux Chromium/Electron report AAC encoding unavailable).

### Phase 21: Restoration Listening Acceptance

*Originally Phase 18. Non-blocking.* **Acceptance:** a documented ABX listening test (16 trials per fixture, p > 0.05) cannot distinguish spectral click repair from the clean reference. Noise reduction achieves ≥15 dB on the stationary-noise fixture with no musical noise reported at default settings. The numerical criteria already pass (22.65 dB; click residual < −80 dBFS).

- [ ] Run and record the ABX protocol on the reference fixtures. [Validation and limits](docs/restoration.md#validation-and-limits).

### Phase 23: Visual Design Follow-up

*Originally Phase 24 open item. Non-blocking; completed effect editor items are in Phase 15 and [visual design](docs/visual-design.md).*

- [ ] Continue visual review with user feedback: remaining populated/error/loading dialogs, combined dense multichannel/spectral/analysis states, complete small-screen focus/scroll access and contrast review at OS scaling settings. Installed Windows/macOS typography/scale is covered in Phase 19.
- [ ] Decide the zoomed-out waveform redesign and sinc interpolation for sample view (outside original Phase U's scope).

### Phase 24: Recording

*Originally Phase 7.* **Acceptance:** a 30-minute 48 kHz stereo recording has no dropped frames. After latency compensation it lines up within ±1 ms of a loopback-measured reference. The Electron microphone permission is already in place.

- [ ] Capture worklet: input → SAB ring (the reverse of playback) → kernel worker appends blocks.
- [ ] Input device selection (`getUserMedia` with echo cancellation, noise suppression and AGC **off**).
- [ ] Input meters, record-arm and monitoring toggle.
- [ ] Record modes: new file, insert at cursor, replace selection (punch-in with pre-roll).
- [ ] Latency measurement (loopback ping) and compensation.

### Phase 25: Performance & Large Files

*Originally Phase 10. Gate corrected 2026-10-08:* the former "3-hour 96 kHz stereo (~4 GB)" target is about 8.3 GB of float32 and also exceeds the 1 GiB encoded-import limit. **Acceptance** for a streaming import of a 2-hour 48 kHz stereo file:
- WASM memory stays under 1.5 GB.
- Open to first paint takes under 10 s.
- Zoom and scroll respond within 100 ms.
- Cut and paste take under 1 s.
- Processing a one-minute selection meets Phase 16's throughput.

Until then, [codecs](docs/codecs.md) documents the supported size limit.

- [ ] Streaming import that decodes into blocks without holding the whole encoded file.
- [ ] Block paging: cold blocks evicted to OPFS (browser) or a temp file (desktop) and faulted back on demand; the peak pyramid stays resident.
- [ ] Waveform rendering in an `OffscreenCanvas` render worker reading peaks directly.
- [ ] Profile the kernel render path in the browser; SIMD where algo-dsp provides it (`GOARCH=wasm` SIMD permitting).
- [ ] Evaluate TinyGo for kernel size and speed (not a goal if the trade-offs are bad).

### Phase 26: Multitrack

*Originally Phase 11.* **Acceptance:** 16 stereo tracks, each with an effect chain, play without underruns at 48 kHz on the reference laptop (Phase 16), and the mixdown matches offline rendering sample for sample.

- [ ] Session model: tracks → clips (document range, gain, fades, offset); non-destructive clip edits.
- [ ] Timeline view: tracks, clip drag/trim/split, snapping, time and bars/beats grid.
- [ ] Mixer: gain, pan, mute, solo, meters, bus sends, per-track `effectchain`.
- [ ] Automation lanes (gain, pan, effect parameters) with breakpoint editing.
- [ ] Mixdown/bounce to a new waveform document or file.
- [ ] Open a clip in the waveform editor (a destructive edit creates a new document version).

### Phase 27: License Policy Compliance

*Originally Phase 23 open items. Policy revised 2026-10-08.*
- **Revision:** the 2026-10-05 MIT/BSD/Apache-only allowlist is replaced by a property-based policy. Bundled code may use OSI-approved, permissive, non-copyleft licenses whose attribution is preserved in the bundled notices: MIT, BSD-1/2/3-Clause, Apache-2.0, ISC, 0BSD, Zlib, BlueOak-1.0.0, Python-2.0/PSF, Unlicense, CC0-1.0 and the Go standard-library notices (including SunPro/Cephes). GPL, LGPL, AGPL, MPL, SSPL and any non-commercial terms remain denied.
- **Dropped:** replacing Go's math library, with no copyleft risk to justify it.
- **Acceptance:** `just check-license-policy` passes, and every accepted exception is reviewed and recorded.

Plans: [Go replacements](docs/licenses/go-replacements.md), [npm replacements](docs/licenses/npm-replacements.md), [Electron audit](docs/licenses/electron-audit.md).

- [ ] Update `docs/licenses/policy.json` to the revised allowlist and add a reviewed `docs/licenses/accepted-exceptions.json` (package, license, reason, reviewer, date) that `just check-license-policy` reads. Unknown expressions keep failing closed.
- [ ] Add full LICENSE grants to `algo-vecmath` and `algo-approx` and tag them, then bump them here. Resolve FLAC's inherited BSD text upstream, and `lazy-val 1.0.5`'s missing grant. An SPDX label does not substitute for a missing runtime license. [Go evidence](docs/licenses/go-audit.md), [npm evidence](docs/licenses/npm-audit.md).
- [ ] Resolve the Electron/Chromium component license selections and platform reach recorded by `licenses-electron.mjs`.
- [ ] *Optional, not a policy blocker:* adopt MIT FLAC (`tphakala/go-flac`) for robustness once an audited upstream tag contains the [local remediation](docs/licenses/flac-remediation.md) fixes. That adoption also needs IETF corpus, bounded import, one-hour memory/performance and native/WASM/browser parity validation.

### Phase 28: CI Stability & Release Process

*Originally R.1 / R.10 follow-ups.*

- [ ] **Allocation flake:** `internal/effects/stream_test.go` (`AllocsPerRun`, "prepared auto-wah render+reset allocate 1") failed in 1 of 6 local `-race` runs. Find the stray allocation or make the measurement robust before it reddens CI. Later isolated and full-catalogue repetitions passed; process-global allocation counters are a suspected, unconfirmed source. [Evidence](docs/benchmarks/r1-ci-2026-10-05.md#allocation-flake).
- [ ] **Short-file EOF snapshot flake:** one parallel `transport.spec.ts` run reported frame 13 instead of 31. Repetitions with passive DOM/output-clock/shared-counter diagnostics pass; the cause is open. Keep the exact 31-frame, zero-underrun and replay assertions. [Evidence](docs/benchmarks/r1-ci-2026-10-05.md#short-file-eof-flake).
- [ ] **Electron security-spec timeout:** on macOS, 2026-10-08, `security.spec.ts` "only app audio permission and explicit external links are allowed" hit the 30 s test timeout and then a worker teardown timeout in one full `just e2e-desktop` run. The rerun was green, and the spec was unchanged.
- [ ] **Electron spectrogram timeout:** the `d1c8caf` CI run failed `analysis…progressive spectrogram` with a 5 s predicate timeout. Decide whether it is a flake or a regression once Phase 29 lets e2e run again.
- [ ] Add `govulncheck` and Dependabot (or Renovate) for Go modules, npm and GitHub Actions; `dep-drift.yml` only covers the `algo-*` family.
- [ ] Machine-generated evidence over 200 KB goes to CI artifacts or release assets, with only a summary `.md` in `docs/benchmarks/`. Example: the 2.4 MB `go-math-reach-2026-10-06.json`. Benchmark reports hold evidence, not open checkboxes, so move the open items in `processing-2026-10-03.md` here or to Phase 16.
- [x] release-please release pipeline (`release.yml`): the release PR's merge creates a draft release that publishes only after green CI, browser/Electron E2E and the strict license policy on the release commit, with unsigned 0.x desktop zips/installers and `aae`/`aae-mcp` zips for six targets plus `SHA256SUMS.txt`. 1.0+ requires signing. E2E no longer runs on ordinary pushes and PRs (only release-please PRs, the `e2e` label and manual runs). The first real run is still to come.
- [ ] Merge the release-please **`v0.1.0` development release** PR once the critical path above is done, with dependency checks and green CI on the release commit. The tag also establishes the `check-unreleased` baseline. [First release](docs/releasing.md#first-release).

---

## Deferred / Later

- **MCP completion** (formerly Phase 22, deferred 2026-10-08). Covers Streamable HTTP transport, offline true peak and silence detection, cross-document extraction, `render_region`, browser-only codec exports, convolution IR loading, structural and chain dry runs with LUFS prediction, numeric rounding and pagination, interactive Claude host acceptance, and an optional live desktop-session server. The list is in [automation & MCP](docs/mcp.md#planned-work).
- Multiple documents open at once (tabs, or one Electron window per document), with copy and paste between them
- Keyboard shortcut customization
- System clipboard exchange (WAV)
- Scrub, varispeed and playback rate
- VST3/CLAP plugin hosting (desktop only, via a native helper process)
- MIDI input for transport control
- Video track for post-production sync
- Collaborative editing
- Scripting API (JS or Lua) on top of the operation model
- Localization (UI strings are English for now)
