# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Phase 0 scaffolding:
  - Bun/Go monorepo with `just` recipes, Biome, treefmt, lefthook and golangci-lint.
  - Go WASM kernel (`packages/kernel`) with a JSON call ABI and a zero-allocation
    render bridge. Its test tone comes from `algo-dsp/dsp/signal`.
  - React 19 + Tailwind v4 + shadcn app shell with a kernel worker, a typed RPC
    client, a SharedArrayBuffer ring buffer and a playback AudioWorklet.
  - Electron shell serving the web build over `app://` with COOP/COEP/CSP headers.
  - Vitest unit tests, Playwright smoke tests for browser and Electron.
  - CI, GitHub Pages deploy and weekly dependency-drift workflows.
