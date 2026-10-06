# Visual design

The editor's look is derived from the supplied app icon (`assets/appicon.png`):
ink/ultramarine surfaces, orchid interactions and bright gold waveforms.
[Edison's workspace](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/plugins/Edison.htm)
is the reference for density: compact grouped tools and an emphasized sample
editor. Components are original and use only licensed assets (system UI fonts,
pinned MIT Heroicons via `@/lib/icons`).

Kernel data, commands, accessibility and editing behavior take precedence over
visual details. Visual changes must not alter audio, selection or history.

## Theme roles

`apps/editor-web/src/index.css` defines the colors as `--editor-*` custom
properties. `src/lib/editor-theme.ts` lists the roles that both DOM controls and
canvas painters use, and `resolveEditorPalette()` resolves them once per paint
context. A missing or unresolved property throws instead of producing an
invalid canvas color.

| Role | Use |
| --- | --- |
| `background`, `foreground`, `mutedForeground`, `border`, `surfaceHover` | Studio surfaces and text |
| `primary`, `primaryHover`, `focus`, `controlTrack` | Interactions, focus rings, knobs, native input accents, selected Loop/channel toggles |
| `selection`, `selectionFill` | Time and spectral selections |
| `waveformPeak`, `waveformSample`, `waveformRms` | Gold peaks/sample dots and tonal gold RMS bucket fills |
| `waveformBackground`, `waveformGrid`, `waveformCenter` | Lane background, quiet amplitude guides, zero line |
| `traceSecondary` … `traceQuaternary` | Additional channels in spectrum, pitch, meters, goniometer and EQ bands |
| `playhead` | Warm playhead |
| `warning`, `destructive`, `error` | Status colors |

Add a role to both `index.css` and `EDITOR_THEME_PROPERTIES` rather than
hard-coding colors in components or canvas code. Theme tests check contrast for
representative text, focus, fields, knobs and traces.

## Waveform workspace

- **Lanes:** `components/waveform/lane-layout.ts` divides the measured available
  height between channels (mono, stereo or split waveform/spectrogram) within
  96–1024 px per lane; dense multichannel files scroll. `PeakCanvas` repaints on
  height changes without refetching peaks.
- **Drawing:** `lib/waveform-drawing.ts` draws exact peak/RMS bucket extents and
  quiet amplitude guides. Above one CSS pixel per sample, signed sample dots are
  drawn with linear or hold connections.
- **Vertical zoom:** 1×–64× magnification around zero, without fetching new
  summaries. Use the view settings, mouse wheel over the amplitude ruler,
  +/−/arrow keys, Home/End or double-click to reset. Channel headers show the
  active factor; linear/dB rulers keep showing actual source levels. A new
  document resets the zoom.
- **Spectrogram:** `FrequencyRuler` shows adaptive linear Nyquist-to-DC scales.
  `SpectrogramCanvas` shows pointer time/frequency readouts; progress, empty and
  error states and the dBFS range sit in a footer below the image so they never
  cover it. Spectral selections, handles and playheads stay inside the image.
- **Analysis dock:** spectrum and meters share a dock capped at 36% of viewport
  height, side by side from 1280 px wide and stacked (scrollable) below.
- **Graphic EQ:** ten vertical gain faders and a separate vertical order fader
  retain editable values and units below. The kernel response graph fills the
  rack width, with logarithmic frequency grid subdivisions and a −24 to +24 dB
  gain axis. Graph dragging adjusts the nearest fixed band; faders support
  keyboard adjustment and double-click reset. Controls wrap on narrow screens.
  Complementary DSP transitions keep equal neighboring gains flat, with the
  first/last gains extending to DC/Nyquist rather than overlapping band peaks.

## Layout limits

Keep these guarded behaviors when changing layout:

- The eight-band EQ fits within 1000 px Full HD height without scrolling.
- Dialogs stay usable at 480×600 and 960×600; menus and meter numbers are not
  clipped at 320 px width.
- The ruler's 160 px position guard, long document/annotation names and narrow
  transport controls wrap rather than overflow.

`e2e/ui-clarity.spec.ts`, `visual-dialogs.spec.ts`, `visual-workspace.spec.ts`,
`visual-palette.spec.ts`, `vertical-zoom.spec.ts` and
`spectrogram-readout.spec.ts` cover these. Dated screenshots are in
[`benchmarks/`](benchmarks/README.md) (visual design, density, palette and
spectrogram readout reports).
