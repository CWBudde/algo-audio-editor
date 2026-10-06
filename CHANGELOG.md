# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Reviewed Go/npm dependency inventory and generated third-party notices in
  About / Status and installers, including retained Electron/Chromium attribution.
  Freshness checks and a strict tagged-release gate preserve unresolved license
  evidence and policy decisions; see [the audit](docs/licenses/README.md).
- Browser and Electron waveform editor with zoom, scrolling, overview and signed
  sample detail; playback, looping and a cursor tied to audible source positions.
- Channel-aware pointer, numeric and keyboard selection, snapping, cut/copy/paste,
  replace, unclipped mix, crop, silence, duplicate, swap and mute. Undo/redo,
  history navigation and save-point tracking retain shared immutable audio blocks.
- Named markers and regions with edit-aware positions, WAV round trips and
  CSV/Audacity-label exports; undoable WAV INFO editing and retained broadcast
  and opaque metadata.
- Cancellable processing with private Preview and atomic Apply: gain, peak/LUFS
  normalization, fades/crossfades, reverse, invert, DC removal, channel conversion
  and extraction, quality-selectable resampling and signal generators.
- Grouped effects catalogue and reorderable racks with live preview, bypass,
  wet/dry, factory and stored user presets, and convolution impulse responses.
  Compact unit-labeled knobs, graphic EQ gain/order faders and full-width
  logarithmic frequency graphs, parametric EQ right-click filter-type menus
  and dynamics input/output graphs provide dedicated controls. Graphic EQ uses
  complementary transitions from algo-dsp v0.11.0 to remove actual audio gain
  spikes between overlapping bands.
- Output peak/RMS/true-peak and loudness meters, loudness range, stereo correlation
  and goniometer; selection/live spectra, progressive spectrograms, statistics,
  pitch tracking and optional clipping markers.
- Spectral rectangle/lasso attenuation, removal and healing; captured-profile
  noise reduction, click/pop repair, declipping, hum removal and pitch-preserving
  time stretch. Workflows and limits are in [restoration notes](docs/restoration.md).
- Go WAV/FLAC/AIFF/AIFC/MP3 import and WAV/FLAC/AIFF export; browser-supported
  Vorbis/Opus/AAC import and WebCodecs Opus/M4A export. Export supports selection
  and channel scope, bit depths, seeded dither and noise shaping; availability,
  precision and metadata limits are in [codec documentation](docs/codecs.md).
- Macro recording, JSON chain import/export/replay and isolated per-file batch
  processing. Native `aae` CLI and stdio `aae-mcp` server share the kernel, with
  explicit write-root permissions, dry-run processing/effects, document resources
  and waveform PNG/binary peaks; see [automation documentation](docs/mcp.md).
- Native menus, dialogs, audio-file open routing and single-instance behavior,
  atomic writes, guarded unsaved close, window-state persistence, supplied app
  icons, three-OS packaging configuration and signing-gated updater scaffolding.
- CI-gated GitHub Pages demo with bundled CC0 audio, cross-origin isolation,
  build diagnostics and cold/warm subpath smoke tests. Native race, actual WASM,
  codec fuzz, web/desktop unit, browser/Electron and Linux package checks accompany
  production asset budgets and dependency-drift workflows.

### Changed

- The waveform fills the workspace without an inset card. Transport, editing,
  zoom, snap, markers, selection start/end/length with units and Channels share
  a compact toolbar; complete tool groups and numeric fields wrap onto new rows.
- App-icon colors guide the editor's ink-blue surfaces, orchid controls and
  bright golden waveform with a tonal RMS core. Selected controls and native
  input accents share the palette; audio plots and meters use gold signal colors,
  distinct channel identities and separate interaction/warning colors.
  The waveform workspace adapts lane heights to the
  window, with refined tool groups, selection readouts and dialog panels.
  A responsive analysis dock adds full-width spectrum scales/channel legends
  and labeled meter values; annotation and clipboard dialogs use compact,
  bounded layouts with readable long names and narrow-screen actions.
- Waveform vertical zoom from 1× to 64× is available in View settings or through
  the amplitude ruler's wheel and keyboard controls. Linear/dB scales reflect
  actual amplitudes; the overview, spectral view and audio remain unchanged.
- Spectrogram and split views have adaptive linear frequency rulers with actual
  Nyquist endpoints and pointer time/frequency readouts. Analysis progress and
  errors sit below the image, preserving spectral selection geometry and detail.
- System UI fonts replace the bundled Geist font; MIT Heroicons replace Lucide
  artwork while preserving accessible editor actions and generated UI components.
- Go lint checks both native and WASM targets with restored revive defaults,
  wrapped-error and security checks. CI pins external actions and the lint
  binary, bounds every runnable job, and caches dependency/browser downloads
  while retaining required installation steps.
- Audio computation stays in the Go kernel and tagged upstream DSP libraries;
  worker render-ahead feeds a SharedArrayBuffer and a copy-only AudioWorklet.
  Native CLI/MCP reuse the platform-independent engine.
- History storage accounting is incremental; shared blocks avoid audio copies,
  and processing/analysis yield between bounded steps to preserve cancellation
  and UI responsiveness.
- Kernel dispatch uses registered handlers and strict typed payload decoding,
  mirrored by the TypeScript protocol. The current kernel ABI is version 18.
- Compact responsive controls, shared menus/commands/palette, lazy dialogs and
  optimized WASM reduce interface and download overhead. Waveforms and selection
  edges expose labeled keyboard controls and retain focus during editing.

### Fixed

- Development and build recipes explicitly run Vite with Bun, avoiding failures
  when its Node shebang selects an older system Node. WASM builds, typechecks,
  browser Playwright and desktop unit tests also use Bun; web DOM unit tests,
  Electron Playwright and Node-specific tools retain Node 24, selected by `.nvmrc`.
- MP3 imports preserve mono channels and trim supported Xing/LAME encoder
  delay/padding; PCM8 WAV data is centered correctly and round-trips every code.
- Surround loudness uses the correct physical channel weights; noise profiles
  avoid padded capture frames, and cursor generators keep unselected channels
  synchronized with inserted silence.
- Interrupted RIFF/RF64 files can recover complete audio frames while retaining
  metadata validation. Codec short reads, stale analysis identities and failed
  processing commits preserve the current document.
- Playback startup/retirement, ring cursor reads, delayed preview/selection
  replies and modal focus restoration are guarded against lifecycle races.
  Lost mutation replies recover authoritative document state.

### Security

- Shared kernel storage/candidate budgets, pre-allocation codec/bridge checks,
  bounded binary transfers and RPC panic recovery reject oversized or invalid
  work without publishing a partial document.
- Electron uses a sandboxed isolated preload, renderer-scoped file/folder
  capabilities, navigation-lifetime revocation, validated protocol paths and
  exact external-link routing. Permissions default to deny, with audio-only
  microphone requests allowed from the trusted live application main frame.
- Packaged Electron fuses disable Node mode, Node environment injection and the
  Node inspector, require ASAR loading and enable embedded ASAR integrity.
  Fuse readback is enforced before signing; integrity enforcement applies on
  macOS/Windows. Installed platform, signing and update acceptance remain open
  in [the roadmap](PLAN.md); [desktop documentation](docs/desktop.md) describes
  the packaged resource boundary.
