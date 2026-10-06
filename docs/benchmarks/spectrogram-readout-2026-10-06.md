# Spectrogram scales and readouts, 2026-10-06

Baseline: `c83589f` on `main`. This Phase 24 increment completes the next locally
actionable spectrogram scale/readout work. Three subagents implemented the
frequency gutter, image footer and production regressions independently; root
integrated selection geometry, reviewed the final images and ran shared checks.

## Display behavior

Spectrogram-only and split views have a linear frequency scale from the actual
file Nyquist frequency to zero. Intermediate ticks adapt to lane height without
changing the spectral pixels or frequency mapping. Split view retains its
amplitude scale and vertical waveform zoom above the independent frequency scale.

Moving over the image shows pointer time in seconds and frequency with units.
Rectangle and lasso overlays use the same image coordinates. The readout describes
the pointer, not a measured magnitude or detected pitch. Hovering does not run
additional analysis, change the selection or add history entries.

A compact footer below each image holds tile progress, the displayed dBFS range
and pointer coordinates. Paused, empty, loading and error states remain readable;
long errors wrap below the image. Lane allocation reserves ordinary footer space,
and dense channels retain scroll access. Selection geometry is explicitly bounded
to the image so the new footer cannot stretch the rectangle/lasso coordinate map.

The smallest browser case found a genuine layout failure before commit: at
320×640 with a populated spectral selection, the channel scroller had zero
client height despite 1,576 px of content. The outer main also had no overflow,
so scrolling could not reveal the image. This failure is retained here rather
than treated as a pointer-test timing issue; the final layout gives lanes a
minimum visible area and lets the outer workspace scroll when controls exceed
the available viewport height.

Final 320×640 geometry: lanes have 128 px visible height and 1,064 px scroll
height; main has 457 px visible height and 626 px scroll height. The wrapped
footer is 49 px high. Native pointer movement, full footer/readout visibility,
keyboard focus and enabled spectral-control semantics pass at this size.

## Production captures

The ordinary production import contains 8,192 float32 frames at 44.1 kHz, with
exact alternating eight-frame runs of +0.25 and −0.25. The mono image and
four-channel split view use Go-computed pixels. A spectral rectangle is a view
selection only; no repair or gain is applied in these captures.

- [Spectrogram ruler and pointer readout](../images/visual-2026-10-06-spectral/spectrogram-pointer.png)
- [Four-channel rectangle at 480 px](../images/visual-2026-10-06-spectral/split-rectangle-narrow.png)
- [Scrollable image/footer at 320×640](../images/visual-2026-10-06-spectral/dense-footer-320.png)

The narrow captures intentionally show a scrolled portion of the document;
they do not claim all channels fit simultaneously on a small screen.

## Checks run

Local Linux amd64, Node 24.12.0 and pinned Go 1.26.8; all build/test commands
ran through `just`.

- Final `just test-web`: **93 files / 1,156 tests passed**, 73.24 s under
  concurrent functional browser work. Focused regressions cover frequency tick
  geometry, exact endpoints, footer state/handler forwarding, no hover analysis,
  control-height growth excluding dense content and accessibility fences.
- Final production Chromium: **47 distinct cases passed** across two separate
  invocations: 44 existing cases (1.3 minutes, two workers), and three new cases
  (22.2 s). The new suite checks DPR 1/2 frequency/time coordinates before and
  after horizontal zoom, exact raster and PCM/source/history identity, physical
  four-channel split rulers and rectangle coordinates, plus full keyboard/footer
  access at 320×640. An artifact-only narrow rerun passed in 6.4 s and retained
  the geometry above. All limits remain unchanged.
- Existing browser coverage includes signed DPR 1/2 sample pixels, vertical zoom
  and overview identity, progressive tiles/edit/undo invalidation, selection,
  keyboard, horizontal navigation, transport including exact short-file EOF,
  rectangle/lasso repair and cancellation, dense channels and combined analysis.
- Final Linux Electron under Xvfb: **four cases passed**, 39.5 s: actual kernel
  analysis/progressive spectrogram, spectral repair and undo, waveform keyboard,
  and `app://` cross-origin isolation.
- `just build`, `just desktop-build`, the final TypeScript/Vite rebuild,
  `just lint-web`, `just fmt check-formatted` and diff checks passed.
- Final unchanged asset limits pass: WASM **10,742,038 raw / 2,906,478 gzip**;
  entry **463,698 raw / 141,415 gzip**; total JavaScript gzip **263,372** bytes.

The initial new browser suite passed both DPR cases and the 480 px rectangle
checks but exposed the zero-height 320 px lane failure. After the layout and
ARIA fixes, the full new suite and all 44 existing cases passed on the final
production build. Browser invocations used separate ports/output directories.

## Validation limits

The Go kernel, audio data, ABI, DSP, dependencies, license policy and generated
shadcn components are unchanged. This increment does not establish the separate
hardware spectrogram/playback timing gate. Full CI, live Pages,
packaged/signed/installed desktop checks, Windows/macOS typography and OS scaling
were not run. User feedback, exhaustive state review and broader platform/scale
acceptance remain open. No publication or upstream adoption occurs.
