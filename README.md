# algo-audio-editor

An audio editor that runs in the browser and as a desktop app. All audio work
(editing, effects, analysis, codecs) happens in a **Go kernel compiled to
WebAssembly** on top of the [`algo-dsp`](https://github.com/cwbudde/algo-dsp)
family. The UI is **React + TypeScript + shadcn**.

> **Status:** Phases 1–2.3 of [PLAN.md](PLAN.md): WAV import/export,
> interactive waveforms, playback, channel-aware selections and editing in the
> browser and Electron, with undo/redo history and save-point tracking.

## Architecture

```
Main thread (React UI) ──postMessage RPC──▶ Kernel Worker (Go WASM)
     │                                          │
     ▼                                          ▼
AudioWorklet "playback"  ◀──── SharedArrayBuffer ring buffer
```

- The kernel runs in a Web Worker and renders audio ahead into a lock-free ring
  buffer. The AudioWorklet only copies; render-ahead buffers absorb worker GC
  pauses without running Go on the audio thread.
- Electron serves the same build over a custom `app://` scheme with the COOP/COEP
  headers that SharedArrayBuffer needs.

## Getting started

Requirements: Go ≥ 1.25, [Bun](https://bun.sh) ≥ 1.3, [just](https://just.systems),
and for formatting `treefmt`, `gofumpt`, `gci` and `shfmt`.

```bash
just install       # dependencies, Electron binary, git hooks
just dev           # http://localhost:5173
just desktop-dev   # the same app in Electron
just ci            # everything CI checks
```

Browser tests start their own production preview. If port 4173 is occupied,
choose a separate port: `AAE_E2E_PORT=44873 just e2e` (also supported by
`just bench-import-browser`).

`just bench-import-browser` measures a full ten-minute WAV import through file
reading, the kernel and drawn waveforms. Run it in isolation on the target
laptop. For native CPU profiling, pass an existing absolute temporary-directory
path to `just bench-import-profile`; it stores the test binary and CPU profile
there and prints the import hotspots.

## Selecting audio

Click a waveform to place the cursor; drag to select time, Shift-click to extend
the nearest edge, or drag either edge handle (arrow keys move it one sample).
Double-click selects the smallest named region under the pointer, otherwise
the interval between adjacent markers, or the whole file if there are none.
Choose All, Left, Right or individual channels to target edits; this does
not mute playback channels.

Enter exact start, end or length in the current ruler format and press Enter or
leave the field to apply it. Escape discards a draft. Invalid or out-of-document
ranges leave the selection unchanged. Optional snapping targets markers/region
edges, displayed ruler ticks and kernel-computed zero crossings within six CSS
pixels. The zero-crossing search radius is also capped at approximately 20 ms
and 8192 frames. Add
named markers at the selection start or regions from a nonempty selection;
their full management, persistence and edit shifting are planned in Phase 2.4.

## Editing audio

Use the edit toolbar or Edit menu to cut, copy, paste or delete a selection.
Ctrl/Cmd+X/C/V work outside text fields. Paste inserts at the selection start;
Replace substitutes its time range, and Mix adds clipboard samples without
clipping or shifting existing audio. The internal clipboard shares immutable
audio blocks and survives opening another file; system clipboard WAV support
is not implemented yet.

Mute silences selected channels without changing duration. Duplicate inserts
the selection immediately after its end; Insert silence uses an exact positive
frame count at its start. Swap exchanges exactly two selected channels within
the range, or throughout the file when the range is collapsed. Crop time always
keeps the selected time range in **all** channels. Other operations target only
selected channels: unselected sample positions remain unchanged, and shorter
channels receive silence at EOF to keep lengths equal.

Paste asks before changing the clipboard's sample rate or channel count. Rate
conversion uses the kernel's sinc resampler. Channel expansion repeats source
channels cyclically; reduction averages source channels folded cyclically into
the targets (mono is repeated; downmix to mono averages every source channel).
The original clipboard is preserved. Conversion bounds new sample storage to
512 MiB and filter workspace to 64 MiB. Mix also bounds newly written samples
to 512 MiB; same-format structural pastes do not have that materialization
limit. Copy keeps playback running; audio-changing edits
stop it. Commands wait until pointer selection and snapping are complete.

Markers and regions currently clamp to valid bounds after edits; their full
edit-aware shifting remains Phase 2.4.

## Undo and saving

Ctrl/Cmd+Z undoes an audio edit; Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y redoes it. The
Edit menu and expandable Edit history panel offer the same controls; click a
history row to jump to that state. Navigation restores audio, selection and
anchor snapshots and stops playback, without changing the clipboard. Editing
after undo discards the redo branch. Copy, selection changes and the current
anchor-only controls do not create audio-history steps.

History retains up to 100 edits plus their base state, sharing unchanged audio
blocks. Its unique sample/peak budget is the greater of 512 MiB and twice the
opened document's storage. Oldest undo states are evicted when needed; an edit
that cannot retain even its immediate undo pair is rejected unchanged. The
panel shows retained audio storage; block-list and runtime overhead are not
included. Keep a separate original for work that must outlive this session.

The history summary and an asterisk in the window title indicate unsaved audio
changes. Save marks only the successfully written history state as saved;
undo/redo back to that state becomes clean, while export alone does not. With
File System Access, the write and close must succeed. The download fallback
can observe only handoff to the browser, not disk completion or cancellation.
Opening another file resets history. Unsaved-close prompts remain Phase 9;
marker/region persistence and corresponding dirty tracking remain Phase 2.4.

## Repository layout

| Path                | Contents                                         |
| ------------------- | ------------------------------------------------ |
| `packages/kernel`   | Go kernel (WASM entry point, engine, protocol)   |
| `packages/protocol` | TypeScript types for the kernel ABI              |
| `apps/editor-web`   | React web app                                    |
| `apps/desktop`      | Electron shell                                   |

## License

MIT, see [LICENSE](LICENSE).
