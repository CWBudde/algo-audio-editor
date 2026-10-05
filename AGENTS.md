# AGENTS.md

Guidance for coding agents (Claude Code and others) working in this repository.

## Project Overview

`algo-audio-editor` is a full audio editor that runs in the browser and as an
Electron desktop app, with native CLI and MCP adapters. The UI is React +
TypeScript; **all audio work happens in a Go kernel**, compiled to WebAssembly
for the editor and natively for automation. It builds on the
`github.com/cwbudde/algo-*` DSP family and tagged codec libraries.

The roadmap and its current state live in [PLAN.md](PLAN.md). Read its
Architecture Summary before changing anything structural.

## Layout

Kernel paths below are relative to `packages/kernel/`; web paths are relative
to `apps/editor-web/`.

| Path | What |
| --- | --- |
| `packages/kernel` | Go module `github.com/cwbudde/algo-audio-editor/packages/kernel` |
| `cmd/kernel` | `js && wasm` entry point: the `syscall/js` bridge |
| `cmd/aae`, `cmd/aae-mcp` | Native CLI and stdio MCP entry points |
| `internal/engine` | Engine coordinator, document/transport/history/job/analysis/effect state and strict protocol dispatch; platform-independent Go |
| `internal/audiobuf` | Immutable planar blocks, shared timeline/window views, peak pyramids and block inventories |
| `internal/ops` | Immutable edits, clipboard and annotation timeline transforms |
| `internal/history` | Undo/save-point snapshots and incremental accounting of shared storage |
| `internal/process` | Bounded, cancellable output builders and adapters to upstream DSP |
| `internal/effects` | Upstream effectchain graph, resource, preview and offline-job adapters |
| `internal/memory` | Shared kernel storage ceiling; the engine owns available capacity |
| `internal/automation` | Native file permissions, operation-chain runner and CLI/batch routing |
| `internal/mcpserver` | Native MCP tools, schemas and inspection resources over the same engine |
| `internal/buildinfo` | Version/time metadata stamped by `scripts/build-wasm.mjs` |
| `internal/protocol` | ABI method names, payloads and response envelope |
| `packages/protocol` | TypeScript ABI mirror (consumed via path alias, no build) |
| `apps/editor-web` | Vite + React 19 + Tailwind v4 + shadcn (Base UI) |
| `src/kernel` | Kernel worker, RPC client, runtime singleton and operation-chain runner |
| `src/audio` | SAB ring buffer, playback worklet and AudioEngine |
| `src/components/ui` | shadcn-generated components; leave as generated, add via `just --command bunx shadcn add` |
| `apps/desktop` | Electron main/preload, `app://` resource handling, native capabilities and packaging hardening |
| `docs/` | Codec, desktop, deployment, restoration and MCP guides; benchmark reports in `docs/benchmarks/` |
| `.github/workflows`, `scripts/` | CI/release/deployment jobs, portable builders and dependency/release guards |

## Commands

Everything goes through `just` (`just --list` shows all recipes):

```bash
just install        # bun install + Electron binary + git hooks
just dev            # build kernel.wasm, start Vite on :5173
just native-build   # build native aae CLI and aae-mcp stdio server
just desktop-dev    # production build in the Electron shell
just desktop-hot    # Electron against the running `just dev` server
just test           # Go tests + web/desktop Vitest
just test-desktop   # main-process policies and filesystem capabilities (Node)
just test-go-wasm   # kernel tests under js/wasm in Node (bridge + golden vectors)
just e2e            # Playwright against the production build
just e2e-pages      # gzip/headerless Pages subpath, cold worker boot and fallback
just e2e-pages-live # deployed URL from PLAYWRIGHT_BASE_URL; no local build/server
just e2e-timing     # opt-in @timing hardware gates; target laptop only, not CI
just e2e-desktop    # Playwright driving Electron (needs a display)
just lint           # golangci-lint, go vet (js/wasm), biome, typecheck
just fmt            # treefmt: gofumpt, gci, biome, shfmt
just check          # fast local gate: format, lint, unit tests, build
just ci             # CI test gates, incl. WASM/fuzz, browser/Pages/Electron e2e
```

Vitest must run one-shot (`vitest run`); watch mode is blocked by a local hook.
`just ci` includes the Linux packaged Electron smoke and needs a display
(`xvfb-run --auto-servernum just ci` on headless Linux). Hardware timing, live
Pages, external EBU/large-file fixtures and installed Windows/macOS acceptance
are separate opt-in checks; a successful local gate does not claim those passed.

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
   `go test` and shared by the native CLI and MCP server.
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

## Changes and verification

Keep commits focused, with bodies describing the behavior and meaningful
validation. Contributor PRs should have a green `CI` workflow before merging;
follow an explicit user instruction to commit directly to `main` when provided.
Report the actual checks run, including skipped platform or hardware gates;
place detailed timing evidence in `docs/benchmarks/` and link it from PLAN.md.
Release tags additionally require the roadmap's release prerequisites and the
signed/installed platform acceptance in `docs/desktop.md`.
See [docs/releasing.md](docs/releasing.md) for publishing gates and remaining
first-release requirements.

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
