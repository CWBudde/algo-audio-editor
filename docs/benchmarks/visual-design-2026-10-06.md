# Visual design validation, 2026-10-06

Baseline: `9e7d2be` on `main`; this report accompanies the Phase 24 visual
revision. Three implementation subagents worked independently on palette/canvas,
workspace geometry and dialogs. The root agent integrated selection and analysis
panels, reviewed production screenshots and ran browser/Electron checks.

The supplied app icon defines the available color reference. Navy surfaces,
violet interaction accents and amber waveforms draw from that image;
[Edison's editor](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/plugins/Edison.htm)
informs workspace density and waveform emphasis. The implementation uses original
editor components and the existing licensed icons and system fonts.

## Implemented appearance

| Role | Color / behavior |
| --- | --- |
| Background / panel | `#0b1020` / `#111a2c` |
| Waveform background | `#0d1527` |
| Peak envelope / RMS core | `#e4b967` / `#b08d4e`, same amber family |
| Primary interaction / selection | `#b69aef`, quiet translucent selection fill |
| Playhead | `#fff1ac` |
| Grid / center guide | `#1b2940` / `#35425a` |

The RMS core uses the kernel's existing summaries; no sample inference,
resampling, smoothing or audio processing was added in JavaScript. Removing the
separate RMS contour also removes interpolation across aggregate buckets.
Exact signed single-frame dots and linear/step joins remain intact. Overview
painting omits amplitude guides and RMS.

Mono/stereo channels share measured available height. Minimum 96 px lanes keep
dense/small views scrollable; maximum 1024 px bounds canvas height. Split view
shares each channel between waveform and spectrogram. Height-only changes repaint
cached data and are included in canvas paint validity. The manual Full HD capture
has 371 px stereo lanes; the 640×720 capture has 161 px lanes. These are layout
observations, not timing guarantees.

Workspace controls, selection fields, channel headers, transport readout and the
empty state were revised individually. Dialogs and secondary panels now share
surfaces, fields, quiet labels and separated actions. Generated shadcn components,
controller/protocol contracts and kernel dependencies were not changed.

## Retained screenshots

- [Full HD workspace](../images/visual-2026-10-06/workspace-full-hd.png)
- [Narrow workspace](../images/visual-2026-10-06/workspace-narrow.png)
- [Eight-band EQ](../images/visual-2026-10-06/parametric-eq.png)
- [Processing](../images/visual-2026-10-06/process.png)
- [Batch processing](../images/visual-2026-10-06/batch.png)
- [Metadata](../images/visual-2026-10-06/metadata.png)
- [Updated bundled-demo screenshot](../images/editor-demo.png)

Workspace and ordinary dialog captures use an independently encoded eight-second
stereo PCM test fixture, imported through the production file flow. Every displayed
summary comes from the actual Go worker. The README image still displays the
bundled four-second demo. The EQ image comes from the existing production browser
test after real keyboard/right-click/drag/knob interactions.

[Manual capture metrics](visual-design-2026-10-06.json) record 13 production
screens: welcome, bundled demo, Full HD/narrow workspace, command palette,
processing, export, metadata, automation, batch, information, statistics and
combined meter/spectrum panels. There were no page errors or horizontal overflow
in those captures. Geometry was allowed to settle before capture. These screen
observations are not a replacement for interaction tests or exhaustive state
review; only the representative images above are retained.

## Checks run

Environment: local Linux amd64, Node 24.12.0, workspace Bun and pinned Go 1.26.8;
Chromium and Linux Electron used the actual production build. All build/dev/test
commands ran through `just`, with `just --command` for focused invocations.

- `just test-web`: **90 files, 1126 tests passed**. Focused agent checks also
  covered theme contrast/drawing, adaptive mono/stereo/split/dense lane bounds,
  transport/status/placeholder and all revised dialog component suites.
- Production browser run: **83 cases passed**, three workers, covering
  `ui-clarity`, `waveform`, `sample-waveform`, `waveform-keyboard`, `selection`,
  `transport`, `effects`, `process`, `analysis`, `export`, `metadata`,
  `automation`, `batch`, `commands` and `history`.
- Linux Electron under Xvfb: **10 cases passed** across smoke, waveform keyboard,
  effects, analysis, export and codecs, including native metadata/focus fencing.
- `just wasm-build`; web TypeScript/Vite production build; `just desktop-build`;
  `just lint-web`; `just check-web-budget`; `just fmt check-formatted` and
  `git diff --check`: passed. Web lint includes both web and desktop typechecks.
- `just check-licenses`: **37 math diagnostic and 20 audit/policy tests passed**,
  with unchanged inventory freshness. Runtime findings remain open in Phase 23;
  this visual increment does not change license policy or clear release findings.

The first 13-case waveform run found the inset toolbar placed the ruler at 176 px
instead of the existing maximum 160 px. Reducing header/selection spacing fixed
the layout without weakening the guard. The initial broad browser run passed
82/83 and found the added EQ chrome made the eight-band dialog 1045 px tall.
Compact help/panel spacing fixed it; the full 83-case rerun passed the unchanged
sub-1000 px, no-scroll Full HD assertions and narrow-width interaction checks.
Independent review then caught a long filename consuming a second toolbar row
at 640 px. Giving the filename only the remaining flex space fixed that issue;
the rebuilt three-case `ui-clarity` suite adds a single-row height guard.

Browser color assertions now resolve the actual peak palette rather than assuming
the former orange RGB range. Sample tests still inspect real pixels and exact
geometry; RMS checks count its opaque core color so antialiased amber sample
strokes are not misclassified as an RMS fill.

## Remaining acceptance

No full `just ci`, live Pages, packaged/signed/installed Windows/macOS, external
fixture or hardware timing acceptance was run. No new kernel test matrix was
needed for this view-only change; browser and Electron exercised the real kernel.
User visual feedback, complete loaded/error/loading screen review, dense-channel
screenshots and installed platform/OS scaling acceptance remain Phase 24 work.
