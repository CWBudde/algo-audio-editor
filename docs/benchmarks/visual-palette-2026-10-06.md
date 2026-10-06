# Visual palette refinement, 2026-10-06

Baseline: `1855909` on `main`. This Phase 24 follow-up responds to the user's
feedback that the colors still did not match the supplied app icon. Three
subagents refined the shared palette, aligned plot colors and added independent
production checks; root integrated selected controls and reviewed actual captures.

## Color treatment

Ink-blue backgrounds and violet-cast raised surfaces replace the previous slate
tones. Bright gold peaks and a darker gold RMS core replace the muted amber/brown
waveform. The core still shows exact kernel bucket extents; this change does not
alter sample geometry, peak requests or any audio computation. Orchid selection,
focus and active parameter arcs stay distinct from gold signal plots. Warnings
and clipping/errors retain their separate semantic roles.

Spectrum/pitch channels share gold, periwinkle, pink and teal identities, with
dash patterns for repeated colors. EQ band colors come from the same central
stylesheet, retaining eight numbered band identities. Native inputs, checked
Loop and pressed channel buttons use the interaction palette. Selected channel
styles use explicit state utilities so generated button utilities cannot obscure
their appearance. Generated shadcn files remain unchanged.

The central theme tests check text, control, focus and trace contrast against
actual stylesheet defaults. Production checks measure rendered foreground and
ancestor-composited background colors, selected/unselected states, field borders,
knob tracks and focus feedback. This is representative local contrast coverage;
it does not establish exhaustive accessibility or installed OS scaling acceptance.

## Production captures

Captures use ordinary file imports into the production Go/WASM editor. The
independent eight-second 48 kHz PCM fixture contains distinct channel frequencies
and repeated decay envelopes. All waveform, spectrum and meter data come from
the kernel. Selection and EQ screenshots show UI drafts without applying edits;
the split view waits for completed spectral tiles.

- [Full HD waveform](../images/visual-2026-10-06-palette/waveform-full-hd.png)
- [Selected time range](../images/visual-2026-10-06-palette/selected-waveform.png)
- [EQ draft and parameter controls](../images/visual-2026-10-06-palette/eq-dialog.png)
- [Combined spectrum and meters](../images/visual-2026-10-06-palette/analysis-full-hd.png)
- [Narrow analysis dock](../images/visual-2026-10-06-palette/analysis-narrow.png)
- [Completed split view](../images/visual-2026-10-06-palette/split-workspace.png)
- [Quiet waveform at 4×](../images/visual-2026-10-06-palette/quiet-waveform-4x.png)

The README screenshot was refreshed with the actual bundled demo at 1280×900.
[Retained capture metrics and check counts](visual-palette-2026-10-06.json) record
seven final manual captures with no page errors or horizontal overflow, plus the
separate production browser zoom capture. The zoom fixture uses two float32
channels alternating exactly ±0.125 for 96,000 frames at 48 kHz. Its overview
remains full scale while the main lanes show 4× magnification and actual levels.

## Vertical waveform zoom

The user added vertical zoom during this pass. View settings provide 1×, 2×,
4×, 8×, 16×, 32× and 64×. Scrolling the amplitude ruler or using its +/− and
arrow keys changes magnification; Home/double-click restores 1× and End selects
64×. All waveform channels share zero-centered display magnification. Channel
headers show active zoom, and the ruler labels actual source amplitudes or their
equivalent dB levels. A new document or client resets zoom.

Only display coordinates change. Cached kernel samples, min/max and RMS retain
their original values and extents; no gain is applied and no new peak request is
needed. The overview stays full scale, and split-view spectral pixels retain
their frequency geometry. The spectrogram-only frequency ruler is noninteractive
for amplitude zoom. A discovered bottom-edge issue for completely negative
saturated buckets now preserves a visible one-pixel strip, matching the positive
edge. Unit and actual DPR 1/2 canvas regressions cover these boundaries and source
identity, not merely a changed zoom label.

## Checks run

Local Linux amd64; Node 24.12.0, existing Bun and pinned Go 1.26.8. Build,
development and test commands ran through `just`.

- `just test-web`: **92 files / 1,143 tests passed**. Focused checks also cover
  central palette contrast and standalone drawing defaults, physical channel
  identities, vertical geometry, rendering and interaction/reset behavior.
- Production Chromium: **108 distinct cases passed across the sweep and isolated
  follow-ups**. The initial 105-case, three-worker sweep passed 101 cases. Two
  analysis cases completed their assertions but failed trace cleanup because
  concurrent Playwright invocations shared the default output directory; both
  passed unchanged with isolated output. The new quiet-envelope oracle initially
  assumed an opaque interior pixel: fractional bucket edges blend, and repeated
  fills at DPR 2 also round individual RGB bytes. The final check uses the
  fully covered first column, permits one-byte raster rounding, and separately
  verifies blank pixels above the magnified envelope. All five zoom cases pass
  at DPR 1/2; all three rendered-palette cases pass with isolated output.
- Browser coverage includes actual signed sample pixels, no zoom peak refetch,
  exact source/history/selection preservation, overview and spectral pixels,
  wheel/keyboard/reset, accurate linear/dB labels, selected-state contrast,
  dense/narrow layouts, right-click EQ types, eight-band Full HD bounds,
  all 51 default effect Preview/Apply paths and 100 batch outputs against the CLI.
- Linux Electron under Xvfb: **10 cases passed**, including analysis, waveform
  keyboard, effects, export, native codec/metadata and `app://` isolation checks.
- `just build`, final TypeScript/Vite build, `just desktop-build`,
  `just lint-web`, formatting and diff checks passed. Unchanged production asset
  limits pass: WASM 10,742,038 raw / 2,906,478 gzip bytes; entry 459,129 raw /
  139,878 gzip bytes; total JavaScript gzip 261,833 bytes.

## Validation limits

This is a view-only increment. Kernel/DSP, ABI, dependencies and license policy
are unchanged. No publication, release or upstream adoption is part of this work.
User feedback, exhaustive dialog/state review, spectrogram scale/readout refinement
and installed Windows/macOS typography/OS scaling remain open in Phase 24.
Full `just ci`, live Pages, packaged/signed/installed platform checks and hardware
timing gates were not run. Browser/Electron used the actual kernel, but this
view-only change did not require a new full Go kernel test matrix.
