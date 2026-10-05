# Historical implementation validation — 2026-10-04–05

These narratives were extracted on 2026-10-05 from
[the roadmap at `1095644`](https://github.com/cwbudde/algo-audio-editor/blob/1095644/PLAN.md).
They preserve reported local validation for the named implementation increments.
**Counts, coverage and asset sizes apply to those runs, not the current tree.**
A reported local `just ci` pass is not evidence of a successful hosted CI run,
installed Windows/macOS execution, actual signing/update acceptance, subjective
listening, or interactive MCP host use. Those remaining requirements stay in
PLAN.md. Original temporary logs/traces are not durable artifacts; these are
transcriptions of retained roadmap evidence, not freshly rerun measurements.

Implementation sources:
[WAV metadata `f8a35c2`](https://github.com/cwbudde/algo-audio-editor/commit/f8a35c2),
[restoration `fb0de8d`](https://github.com/cwbudde/algo-audio-editor/commit/fb0de8d),
[desktop `2c8a8ed`](https://github.com/cwbudde/algo-audio-editor/commit/2c8a8ed),
[MCP foundation `ee79901`](https://github.com/cwbudde/algo-audio-editor/commit/ee79901),
[batch/inspection `b739447`](https://github.com/cwbudde/algo-audio-editor/commit/b739447),
[CI regression follow-up `c3d9180`](https://github.com/cwbudde/algo-audio-editor/commit/c3d9180).

## WAV metadata

**WAV metadata validation (2026-10-04):** `just ci` passes with **907 frontend tests in 69 files**, native Go race/coverage, lint/typechecks, formatting/tidy and production build; the complete V8/WASM kernel suite also passes. All **27 focused production Chromium metadata/codec/export tests** and **nine focused Electron native/codec tests** pass, including real download/disk write/reopen, modal fencing and unchanged PCM/source state. Metadata regression fixtures are constructed independently on the RIFF wire, covering opaque/BWF bytes, legacy INFO text, field deletion, annotation supplements, selection filtering and uninterrupted kernel transport. Current sibling tags and a WAV fuzz smoke pass. MP3/FLAC tags and Phase 6.4 persistence remain pending.

## Restoration

**Validation:** `just ci`, actual V8/WASM kernel tests and `just check-deps` pass. Frontend: 869 unit tests. Chromium: 116 scenarios pass in the full parallel run; the existing YIN analysis scenario hits its 5-second result timeout during concurrent Electron testing and passes on an isolated rerun. Electron: all six scenarios pass. Processing coverage is 90.3%; engine coverage is 87.8%.

## Desktop integration

**Validation:** `just ci` (native Go race tests, lint/types, formatting, module tidy, production build), 880 frontend tests, all 117 functional Chromium scenarios across the full run and isolated reruns, all 11 ordinary Electron scenarios plus the Linux packaged smoke, a frozen Bun 1.4.2 install, and `actionlint` for both changed workflows. Under concurrent host load, some existing browser/Electron/unit waits timed out; all affected cases pass in isolated reruns with the original limits. Linux AppImage and deb build locally. Phase 9 is intentionally partial: Phase 6 projects/persistence and external signing/release acceptance remain unimplemented.

## Batch and inspection shared validation

**Validation (2026-10-04):** Full `just ci` passes formatting/lint/typechecks/tidy, native race/coverage, actual V8/WASM tests, both fuzz smoke checks, **962 frontend tests**, **145 browser tests**, **4 Pages tests**, **21 Electron tests** and the separate packaged Linux smoke. The normal desktop suite skips its packaged-only case, which passes in the dedicated packaged recipe. Nineteen new frontend unit tests cover batch orchestration/configuration, and four new Electron cases verify actual batch processing and folder-grant confinement/lifecycle. ABI 18 is unchanged; native Windows/macOS acceptance remains pending.

## UI batch parity

**UI batch acceptance (2026-10-04):** Four production browser cases pass, including **100 distinct stereo files** processed through −16 LUFS normalization, edge fades and 44.1 kHz/16-bit FLAC. All 100 outputs are **byte-for-byte identical** to the compiled native CLI using the same chain. Corrupt-input continuation, cancellation during an authoritative save, worker disposal and an actual download preserve the editor document, samples and history. Desktop regression processes two actual files into one selected folder with exact reverse samples; folder IPC tests cover traversal, destination symlinks, no overwrite, cleanup and expired grants. Desktop/narrow dialog screenshots have no horizontal overflow. Native Windows/macOS execution remains open.

## MCP first increment

**First-increment validation (2026-10-04):** full `just ci` passes (native race/coverage, actual V8/WASM, both fuzz smokes, formatting/lint/typechecks/tidy, 910 frontend, 134 browser, four Pages, 16 Electron and one packaged Linux smoke). The final native MCP/automation race tests and Go lint pass after schema-discovery/structural-save regressions were added. `just native-build`, `actionlint`, `check-deps` and `git diff --check` pass. A separate real stdio client drove the compiled `aae-mcp` binary through demo open/statistics → normalize to −16 LUFS → resample to 44.1 kHz → 16-bit FLAC export. The compiled `aae` binary ran the same chain: both outputs are identical, 176,400 stereo frames / 162,976 encoded bytes (SHA-256 `a74f893f5d46f0c36cb9b9bbceb8abe3ef561ff6d6ac340b6460dbdeeb48c8d5`). Native adapters are excluded from the WASM executable; raw kernel size remains 11,063,065 bytes.

## MCP inspection

**Inspection validation (2026-10-04):** Full `just ci` passes native race/coverage, actual V8/WASM and fuzz checks, formatting/lint/typechecks/tidy, 962 frontend, 145 browser, four Pages, 21 Electron tests and the packaged Linux smoke. Four new SDK client regressions verify seconds selection, physical channels, exact binary peak transport, current PNG/resources and bounded rendering over fragmented kernel storage. Eighteen advertised tool schemas match the golden; native-only image rendering leaves kernel ABI 18 unchanged. Interactive Claude host acceptance, HTTP/live desktop transport and remaining tool-surface items stay open.

## Browser CI regression follow-up

- [x] Browser CI run `37239688144` regressions (2026-10-05): `edits.spec.ts` now constructs shared silence exceeding the unified 3 GiB storage budget and checks the engine's memory-budget error; `export.spec.ts` checks centered PCM8 bytes from `wav v0.1.4`. `useProcess.open` captures the launcher before the document lock disables it and the lazy dialog loads; `finish` releases that lock before closing, and `ProcessDialog` restores focus after React's unmount commit. Preview stays in the processing phase until playback startup settles, preventing an enabled Apply click from being discarded while a preview is still pending. Unit regressions cover delayed playback, delayed lock release and conditional-unmount focus. Local `just e2e` passes all 146 browser tests without retries; all four Pages tests, 1,078 frontend unit tests, web lint/typechecks, formatting and production size budgets pass.

## Short-file EOF snapshot

**Historical Phase 3.3 concern, 2026-10-03:** Investigate the historical short-file EOF/device-clock snapshot concern from Phase 3.3: one parallel browser run reported frame 13 instead of 31; both the initial parallel and final serial 101-case sweeps passed the original assertions. The tentative snapshot-race explanation was not confirmed because the trace was cleaned. Product cursor code/assertions were unchanged; historical logs were `/tmp/phase33-browser.log` and `/tmp/phase33-transport.log` (temporary paths, not durable artifacts).
