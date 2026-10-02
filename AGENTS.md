# AGENTS.md

Guidance for coding agents (Claude Code and others) working in this repository.

## Project Overview

`algo-audio-editor` is a full audio editor that runs in the browser and as an
Electron desktop app. The UI is React + TypeScript; **all audio work happens in
a Go kernel compiled to WebAssembly**, built on the `github.com/cwbudde/algo-*`
DSP family (mainly `algo-dsp` and `wav`).

The roadmap and its current state live in [PLAN.md](PLAN.md). Read its
Architecture Summary before changing anything structural.

## Layout

| Path                 | What                                                                         |
| -------------------- | ---------------------------------------------------------------------------- |
| `packages/kernel`    | Go module `github.com/cwbudde/algo-audio-editor/packages/kernel`              |
| `  cmd/kernel`       | `js && wasm` entry point: the `syscall/js` bridge, nothing else               |
| `  internal/engine`  | All kernel state and protocol methods; pure Go, tested natively              |
| `  internal/protocol`| ABI: method names, payloads, response envelope                               |
| `packages/protocol`  | TypeScript mirror of `internal/protocol` (consumed via path alias, no build) |
| `apps/editor-web`    | Vite + React 19 + Tailwind v4 + shadcn (Base UI)                              |
| `  src/kernel`       | Kernel worker, RPC client, runtime singleton                                 |
| `  src/audio`        | SAB ring buffer, playback worklet, AudioEngine                               |
| `  src/components/ui`| shadcn-generated components; leave as generated, add via `bunx shadcn add`   |
| `apps/desktop`       | Electron main + preload; serves `editor-web/dist` over `app://`              |

## Commands

Everything goes through `just` (`just --list` shows all recipes):

```bash
just install        # bun install + Electron binary + git hooks
just dev            # build kernel.wasm, start Vite on :5173
just desktop-dev    # production build in the Electron shell
just desktop-hot    # Electron against the running `just dev` server
just test           # Go tests + Vitest
just e2e            # Playwright against the production build
just e2e-desktop    # Playwright driving Electron (needs a display)
just lint           # golangci-lint, go vet (js/wasm), biome, typecheck
just fmt            # treefmt: gofumpt, gci, biome, shfmt
just ci             # everything CI runs, locally
```

Vitest must run one-shot (`vitest run`); watch mode is blocked by a local hook.

## Architecture rules (critical)

1. **No sample processing in JS.** JS may move samples (ring buffer, transfer,
   worklet copy) and draw what the kernel computed (peaks, spectra). Gain,
   filters, analysis and mixing belong in the kernel. Codec glue that only the
   browser can do (`decodeAudioData`, WebCodecs) is the one exception, and its
   output goes straight to the kernel.
2. **The kernel never runs on the audio thread.** It renders ahead into the
   SharedArrayBuffer ring from its worker; the AudioWorklet only copies.
   Nothing in `process()` may allocate, post messages or call into WASM.
3. **ABI changes touch both sides in one commit.** Change
   `internal/protocol/protocol.go` and `packages/protocol/src/index.ts`
   together, and bump `protocol.Version` / `PROTOCOL_VERSION` when an existing
   payload changes shape.
4. **Bulk data never travels as JSON.** Audio, peaks and files cross the
   boundary as transferable `ArrayBuffer`s or through the SAB.
5. **`internal/engine` stays platform-independent.** Anything touching
   `syscall/js` lives in `cmd/kernel`, so the engine is testable with plain
   `go test` and reusable for the Phase 12 native CLI.
6. **Missing DSP goes upstream.** If the kernel needs an algorithm that belongs
   in `algo-dsp` (fades, STFT, true peak, noise reduction…), implement it there
   with tests, tag a release there, then bump it here. No DSP copies in this
   repo, and no pseudo-versions in `go.mod`.
7. **Cross-origin isolation is load-bearing.** SharedArrayBuffer needs
   COOP/COEP. They are set in `vite.config.ts` (dev/preview),
   `public/coi-serviceworker.js` (Pages) and `apps/desktop/src/main.ts`
   (Electron). Any new hosting path must provide them too.

## Conventions

- Go: errors wrapped as `fmt.Errorf("method: context: %w", err)`;
  table-driven tests; zero allocations in render paths (check with
  `-benchmem`).
- TypeScript: strict, `erasableSyntaxOnly` (no enums, no parameter
  properties), double quotes, Biome-formatted.
- Electron: `contextIsolation`, `sandbox`, no `nodeIntegration`. Every preload
  API is mirrored in `apps/editor-web/src/platform.ts`. Do not derive paths
  from `__dirname` in `apps/desktop`; the bundler inlines it as the source
  directory. Use `app.getAppPath()`.
- Conventional commits; technical writing in English.
- Mark finished PLAN.md items `[x]` and rewrite them to say what was actually
  done (files, functions, regression test).

## The algo-* family: releasing, and not drifting

This repo consumes the `github.com/cwbudde/algo-*` family and follows its
anti-drift rules (see algo-dsp's AGENTS.md for the history behind them):

```bash
just check-deps        # all github.com/cwbudde/* deps at their latest tags?
just check-unreleased  # untagged work piling up on main?
```

`check-deps` is part of the weekly `dep-drift.yml` job. If a bump is
deliberately deferred, write down why in PLAN.md. Releases flow up the
dependency graph, and this app sits at the top:

```
algo-vecmath ─┐
algo-approx  ─┼─→ algo-dsp ──→ algo-audio-editor
algo-fft ─────┘     wav ───┘
```
