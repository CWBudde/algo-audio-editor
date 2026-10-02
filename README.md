# algo-audio-editor

An audio editor that runs in the browser and as a desktop app. All audio work
(editing, effects, analysis, codecs) happens in a **Go kernel compiled to
WebAssembly** on top of the [`algo-dsp`](https://github.com/cwbudde/algo-dsp)
family. The UI is **React + TypeScript + shadcn**.

> **Status:** Phase 0 of [PLAN.md](PLAN.md). The full pipeline runs end to end
> (Go kernel → worker → SharedArrayBuffer → AudioWorklet, in the browser and in
> Electron); editing features start in Phase 1.

## Architecture

```
Main thread (React UI) ──postMessage RPC──▶ Kernel Worker (Go WASM)
     │                                          │
     ▼                                          ▼
AudioWorklet "playback"  ◀──── SharedArrayBuffer ring buffer
```

- The kernel runs in a Web Worker and renders audio ahead into a lock-free ring
  buffer. The AudioWorklet only copies, so Go's garbage collector never causes
  dropouts.
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

## Repository layout

| Path                | Contents                                         |
| ------------------- | ------------------------------------------------ |
| `packages/kernel`   | Go kernel (WASM entry point, engine, protocol)   |
| `packages/protocol` | TypeScript types for the kernel ABI              |
| `apps/editor-web`   | React web app                                    |
| `apps/desktop`      | Electron shell                                   |

## License

MIT, see [LICENSE](LICENSE).
