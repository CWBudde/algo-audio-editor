# Visual density validation, 2026-10-06

Baseline: `3ea2ffd` on `main`. This Phase 24 follow-up continues the supplied
icon's navy/violet/amber design. Three implementation subagents worked on
analysis panels, annotation/clipboard dialogs and dense/split waveform controls
and browser checks. Root integrated the dock, menus, processing controls and
container sizing, reviewed production screenshots and ran local validation.

## Implemented layouts

The spectrum and meters share a dock limited to `min(24rem, 36dvh)`. They sit
side by side from 1280 px. Below that width the dock scrolls through natural
panel heights, preserving waveform and footer space. Wide panels own their
overflow. Meter cells use the available channel-block width, with two numeric
columns below 360 px and four above it. The panel's wider arrangements group
channels, loudness and stereo image without imposing those columns on small
panels. The existing meter subscription and ahead-of-device meaning remain.

Spectrum scales show logarithmic frequency and dBFS guides, exact Nyquist
labels and matching physical-channel color/dash legends. Measured SVG width
prevents a fixed aspect ratio from leaving the graph in the middle of a wide
surface. A resize regression verifies retained SVG/results and exactly one
analysis call. The plot has a 480 px minimum width for readable scales; very
narrow panels allow internal horizontal graph scrolling. These are mappings
of kernel-computed results; no audio analysis or processing moved to JavaScript.

Spectral tools use compact labeled controls. Existing channel heights and
scrolling behavior are retained, now exercised with real six/eight-channel
imports and split stereo. Annotation list rows separate names, times and actions;
long unbroken names wrap, and edit forms/actions remain reachable. Clipboard
conversion matches the studio dialogs and respects viewport bounds. Menus reserve
room for shortcuts, and disclosure open states match the violet interactions.
Processing controls use shared fields; processing/export document names wrap.

## Retained production captures

- [Full HD spectrum and meters](../images/visual-2026-10-06-density/analysis-full-hd.png)
- [Narrow analysis dock, scrolled toward meters](../images/visual-2026-10-06-density/analysis-narrow.png)
- [Completed stereo split view](../images/visual-2026-10-06-density/split-workspace.png)
- [Eight-channel document, scrolled to its final channels](../images/visual-2026-10-06-density/dense-workspace.png)
- [Narrow annotation draft and actions](../images/visual-2026-10-06-density/annotation-narrow.png)

[Capture metrics](visual-density-2026-10-06.json) retain five settled production
screens, with no page errors or page horizontal overflow. The fixtures are
independently encoded eight-second, 48 kHz PCM WAVs. Each channel has a distinct
sine frequency and repeated decay envelope; ordinary file import supplies all
displayed kernel peaks, spectra and meter data. The split capture waits for both
spectrograms to complete. The narrow dock capture intentionally shows its scroll
position; it does not claim every analysis value is visible simultaneously.

These screenshots are visual observations, not timing or external corpus gates.
The original README demo capture remains valid for the unchanged basic workspace.

## Checks run

Local Linux amd64, Node 24.12.0, existing Bun and pinned Go 1.26.8. Builds,
development servers and checks ran through `just`; focused invocations use
`just --command`. Browser checks use the production build and actual Go worker.

- `just test-web`: **91 files / 1130 tests passed**, including the added spectrum
  scale, physical-channel identity and resize regressions. Earlier focused
  checks covered waveform/lane sizing, dialogs, disclosures and analysis panels.
- Initial targeted production browser pass: **24 cases passed**, covering
  analysis, edits, timeline, UI clarity and both new visual suites. Screenshot
  review then caught spectrum letterboxing; measured plot width and a resize
  guard correct it without changing analysis lifecycle or reducing assertions.
- Final production browser sweep: **100 cases passed**, three workers. It covers
  both visual suites, UI clarity, waveform/sample pixels at DPR 1/2, keyboard and
  selection, transport, timeline, edits, history, effects, processing, analysis,
  export, metadata, automation, batch and commands. Existing eight-band EQ
  Full HD bounds/right-click/knob guards pass, as do all 51 default effect
  preview/apply cases and 100 actual batch outputs against the native CLI.
- Linux Electron under Xvfb: **10 cases passed**, across smoke, waveform keyboard,
  effects, analysis, export and native codec/metadata cases.
- `just build` (including WASM), final web TypeScript/Vite build,
  `just desktop-build`, `just lint-web`, `just check-web-budget` and
  `just check-licenses`: passed. Inventory freshness passes; existing Phase 23
  runtime release-policy findings remain open and unchanged.
- `just fmt check-formatted` and `git diff --check`: passed.

## Remaining acceptance

No full `just ci`, live Pages, packaged/signed/installed Windows/macOS or hardware
timing gate was run. No new kernel test matrix was needed for this view-only
increment; actual browser/Electron kernels were exercised. Kernel/DSP, ABI,
dependencies, generated shadcn components and license policy are unchanged.

User feedback, exhaustive populated/loading/error review, combined dense-channel
spectral/analysis states, spectrogram scale/readout refinement and installed
platform typography/OS scaling acceptance remain open in Phase 24. Tested browser
widths from 320 px and short dialogs at 600 px height do not establish all devices,
zoom settings or contrast/focus acceptance.
