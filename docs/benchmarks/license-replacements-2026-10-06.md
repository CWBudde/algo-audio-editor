# Font/icon replacement validation — 2026-10-06

Baseline: `f5ae802` plus this Phase 23 working tree. Linux x64, Node 24.12.0,
Bun 1.4.2 for dependency changes, Go 1.26.8 and Electron 44.5.1. This is local
implementation evidence; installed Windows/macOS typography, hosted CI and
public-release approval remain open.

System UI fonts replace bundled Geist; exactly pinned MIT Heroicons 2.2.0
replace Lucide paths and types. The generated shadcn files remain byte-identical:
their imports resolve to a narrow local Heroicons facade in TS, Vite and Vitest.
[Implementation and regeneration details](../licenses/npm-replacements.md)
explain the generated-template setting and dependency-removal step.

The regenerated inventory contains 742 entries, with 61 runtime and 681
development entries. It retains 863 license/notice texts; npm contributes 714
identities and 691 texts totaling 1,513,948 bytes. The application notice asset
is 262,303 bytes. Only Geist and Lucide identities were removed and Heroicons
added; other locked versions are unchanged. One previously unavailable s390x
Rolldown archive was successfully inspected on regeneration; its development
missing-grant finding remains. Go dependency inputs and the Electron binary
notice inventory are unchanged.

Checks completed:

- `just licenses`, `just check-licenses`: exact-source regeneration, 20
  collector/policy tests and inventory/digest/notice freshness pass. Heroicons'
  full MIT grant is retained; the removed dependencies are absent from the lock,
  inventory and application notices.
- `just test-web`: 89 files / 1,122 tests pass. Five new icon regressions cover
  actual alias resolution, manifest exclusion, generated export compatibility,
  source import restrictions, currentColor sizing and SVG ref forwarding.
- `just test-desktop`: six files / 144 tests pass.
- `just lint-web`: Biome and both web/desktop typechecks pass.
- `just fmt check-formatted`, `git diff --check` and 74 local Markdown
  paths/anchors pass.
- `just build` and `just check-web-budget`: optimized WASM and production assets
  pass existing limits. WASM raw 10,742,038 / gzip 2,906,474 bytes; entry raw
  444,914 / gzip 136,449; total JavaScript gzip 257,095. The subsequent web-only
  rebuild verifies the final CSS/font-asset guard against the same WASM.
- Five isolated Vite/Tailwind build probes: resolved Lucide JS, inlined Geist
  font CSS, an emitted WOFF2 file and binary-source CSS with a font-face rule
  are rejected; system-font CSS succeeds.
  Review reproduced a Tailwind bypass of the original module-only check; the
  production plugin now additionally rejects emitted font files and `@font-face`
  rules, including inlined font data.
- Production Chromium: 14 cases pass across UI clarity, effects, waveform
  keyboard, commands and notices (eight cases in 10.7 s, six in 6.1 s). They
  cover 1920×1080 and 640×720 layout, zero font requests/downloadable font faces,
  icon action visibility, EQ and dynamics graphs, right-click/keyboard controls,
  menu routing, focus and exact on-demand notices. The macOS-modifier case
  simulates browser platform shortcuts; it is not installed macOS acceptance.
- Linux unpacked application built from the verified web/desktop artifacts;
  actual packaged Electron smoke passes (one case, 26.1 s), including retained
  Electron/Chromium notice bytes, exact application notices through `app://`,
  sandbox/isolation and fuse checks.
- `just check-license-policy` fails as intended with 12 runtime findings,
  including overlapping evidence/policy findings. Font/icon findings are
  cleared; the strict policy is unchanged.

The separate [FLAC evaluation](../licenses/flac-evaluation.md) records seven-target
compilation, actual native/WASM malformed-input probes and independent reference
comparisons. It did not change the product's codec dependency or establish
adoption compatibility.

Full `just ci`, product Go race/WASM/fuzz suites, Pages/live deployment, hardware
timing, the external IETF codec corpus, signed installers and installed
Windows/macOS checks were not run. Product kernel/DSP/protocol code is unchanged.
No dependency license was altered, and no tag, publication or remote setting
was changed.
