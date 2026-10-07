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
- **Parametric EQ:** six default handles span 30 Hz–14 kHz at approximately
  equal logarithmic intervals: highpass, low shelf, two peaks, high shelf and
  lowpass. At low sample rates the interval compresses below Nyquist. Pass
  handles stay at zero gain and edit cutoff/Q; their gain controls are disabled
  without discarding stored gain. Six control cards use a balanced three-column
  layout on wide screens. The graph fills the rack width with fixed-size text
  and handles. A compact band-count dropdown sits beside the active
  band readout below the graph. Each card places an Order dropdown beside Type
  on the right, with orders 2–12 in steps of two. Higher-order pass/shelf Q is
  fixed to Butterworth damping; peak Q remains editable. Right-click menus
  include both pass types. Wheel over a handle adjusts Q: up narrows bandwidth,
  down widens it, and Shift gives fine adjustment. The gesture consumes scrolling
  only over handles and preserves fixed Butterworth Q.
- **Filters:** one Filter entry replaces the generic and predefined filters;
  Type and Family selectors precede compact knobs and an optional Order dropdown.
  Unsupported families are omitted; changing type resets an incompatible family
  to RBJ. Q, bandwidth, ripple and stopband appear only when used by the design.
  Moog uses drive/resonance/oversampling and live preview. One Weighting filters
  editor selects A or C. Both linear editors share a full-width, 320 px tall
  frequency readout with logarithmic subdivisions, −96 to +24 dB and pointer
  values. Their dialogs use 80% of the previous maximum width (51.2 rem), while
  retaining the viewport margins on narrow screens. Butterworth and Chebyshev
  orders extend to 20; Bessel stays at 10 and elliptic at 12. Existing node IDs
  stay readable in saved presets and automation.
- **Compressor:** its 51.2 rem dialog places a square transfer plot beside two
  columns of knobs in three rows (threshold/ratio, knee/makeup, attack/release).
  Auto gain sits below Makeup and disables its manual control without losing
  the stored value. Below 760 px wide, plot and controls stack. The input-level
  inspection slider and help paragraph are removed; curve inspection retains
  pointer/touch and Left/Right/Home/End keyboard access, with a compact readout.

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
