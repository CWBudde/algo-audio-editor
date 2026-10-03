# algo-audio-editor

An audio editor that runs in the browser and as a desktop app. All audio work
(editing, effects, analysis, codecs) happens in a **Go kernel compiled to
WebAssembly** on top of the [`algo-dsp`](https://github.com/cwbudde/algo-dsp)
family. The UI is **React + TypeScript + shadcn**.

> **Status:** Phases 1 and 2.1 of [PLAN.md](PLAN.md): WAV import/export,
> interactive waveforms, playback and channel-aware selections in the browser
> and Electron. Destructive editing and undo/redo are next.

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
Choose All, Left, Right or individual channels to target later edits; this does
not mute playback channels.

Enter exact start, end or length in the current ruler format and press Enter or
leave the field to apply it. Escape discards a draft. Invalid or out-of-document
ranges leave the selection unchanged. Optional snapping targets markers/region
edges, displayed ruler ticks and kernel-computed zero crossings within six CSS
pixels. The zero-crossing search radius is also capped at approximately 20 ms
and 8192 frames. Add
named markers at the selection start or regions from a nonempty selection;
their full management, persistence and edit shifting are planned in Phase 2.4.

## Repository layout

| Path                | Contents                                         |
| ------------------- | ------------------------------------------------ |
| `packages/kernel`   | Go kernel (WASM entry point, engine, protocol)   |
| `packages/protocol` | TypeScript types for the kernel ABI              |
| `apps/editor-web`   | React web app                                    |
| `apps/desktop`      | Electron shell                                   |

## License

MIT, see [LICENSE](LICENSE).
