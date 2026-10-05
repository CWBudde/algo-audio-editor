# npm replacements under the existing license policy

Research date: 2026-10-05. The user chose to retain MIT/BSD/Apache-only bundled
dependencies and plan replacements. The font/icon replacements below are implemented;
updater replacement remains proposed. No license exceptions were granted and
the first-release gate remains open. The current per-version evidence is
in [the dependency manifest](dependencies.json) and [npm audit](npm-audit.md).

## System fonts — implemented (2026-10-06)

Removed `@fontsource-variable/geist` from the workspace manifest/lock and its
CSS import. `--font-sans` uses
`system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`.
These are locally installed fonts; no font files are redistributed. This follows
the [CSS Fonts definition](https://drafts.csswg.org/css-fonts-4/#system-ui-def).

The production `ui-clarity.spec.ts` regression checks the computed stack, zero
font requests and zero downloadable font faces, plus 1920×1080 and 640×720
waveform/footer/action visibility. Production builds reject resolved Geist modules,
emitted font assets and CSS `@font-face` rules, including inlined font data.
Linux Chromium acceptance is recorded in
[the replacement checks](../benchmarks/license-replacements-2026-10-06.md).
Installed Windows/macOS typography remains unverified; those platforms use their
own system fonts and may have different metrics.

## MIT icons — implemented (2026-10-06)

Replaced `lucide-react@1.50.0` with exactly pinned `@heroicons/react@2.2.0`.
The [tagged MIT grant](https://github.com/tailwindlabs/heroicons/blob/v2.2.0/LICENSE)
and full installed grant are retained in the inventory and shipped notices.
Its React peer is the only declared runtime dependency; no Lucide SVG paths
were copied or relicensed.

Handwritten components use `src/lib/icons.ts`, which maps semantic editor
actions to Heroicons outline artwork and owns the `IconComponent` SVG prop
type. Existing accessible labels, button sizes and currentColor styling remain.
Crop, snapping and selection-fit actions use distinct available glyphs;
accessible names retain their exact action meanings.

Generated shadcn files stay byte-identical. `components.json` intentionally
retains `iconLibrary: lucide` as the template setting; matching TypeScript
and exact Vite/Vitest aliases resolve their `lucide-react` import to
`src/lib/shadcn-icons.ts`, a seven-export Heroicons facade. This is a local
module alias, not an installed Lucide package. Newly generated names must be
mapped explicitly before typechecking passes. Compatibility tests guard every
generated icon export and reject handwritten Lucide imports. Production builds
also reject actual resolved Lucide package modules. Do not reinstall Lucide
when regenerating components. The generator may add it automatically: remove that
manifest entry and update the lock using Bun 1.4.2, then update the facade for any
new symbols, regenerate notices and rerun typecheck/tests, as described in AGENTS.md.

Bun 1.4.2 removed both old dependencies and added Heroicons without changing
other locked package versions. The exact-source audit/notices were regenerated;
font and Lucide policy findings are cleared while the remaining gate stays open.

## Replace the updater dependency closure as one feature

`apps/desktop/src/updates.ts` imports `electron-updater`. The desktop build keeps
it external, and electron-builder includes application production dependencies.
The following packages therefore remain runtime inventory even when a particular
module is used only by a dependency's CLI. The dependency owners are confirmed
by the installed locked manifests and the
[electron-updater 6.8.9 manifest](https://github.com/electron-userland/electron-builder/blob/electron-updater@6.8.9/packages/electron-updater/package.json).

| Blocking evidence | Dependency owner | Current role |
| --- | --- | --- |
| `semver@7.7.4`, ISC | `electron-updater` | Version comparison in `AppUpdater` and GitHub provider |
| `graceful-fs@4.2.11`, ISC | `electron-updater` → `fs-extra@10.1.0` | Filesystem adapter used by several updater paths |
| `argparse@2.0.1`, Python-2.0 | `electron-updater` → `js-yaml@4.3.2` | Required by js-yaml's CLI; still part of its packaged dependency closure |
| `sax@1.6.1`, BlueOak-1.0.0 | `electron-updater` → `builder-util-runtime@9.7.0` | XML parsing exported by the runtime utilities |
| `lazy-val@1.0.5`, missing full grant | `electron-updater` | Direct lazy initialization dependency |

The [versioned updater implementation](https://github.com/electron-userland/electron-builder/blob/electron-updater@6.8.9/packages/electron-updater/src/AppUpdater.ts)
uses these utilities for application configuration, update checking and download
state. Selectively removing packages from an installer without proving every
platform's import graph is unsafe. `argparse` may be avoidable with an audited
bundled updater build that excludes the CLI, but that alone leaves the other
blockers.

There are three concrete paths:

1. **Manual release installation:** replace the update controller with a
   main-process action opening this repository's fixed HTTPS releases page.
   Preserve NSIS, AppImage/deb and dmg/zip artifacts; users install signed releases
   themselves. Remove `electron-updater` from application dependencies and its
   external build flag. Extend `allowedExternalURL` for the exact releases page,
   since the existing allowlist currently permits only the repository home and
   PLAN link. This is the smallest proposed replacement, but loses in-app
   checking, consented download and restart-to-install behavior. Keep Phase 19's
   automatic-update acceptance open unless its scope is explicitly revised.
2. **Use Electron's updater with a packaging migration:** investigate the built-in
   [Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater).
   It supports macOS and Windows, with Windows Squirrel/MSIX packaging, while
   this app uses NSIS. It has no Linux updater. It also downloads automatically
   when checking, unlike the app's current separate Download/Cancel step.
   Consequently this path requires packaging/feed changes, a redesigned consent
   flow, and an explicit Linux update approach. It is not a drop-in import swap.
3. **Maintain a compatible updater with allowed dependencies:** fork the MIT
   updater and runtime utilities at immutable versions, retaining their grants.
   Replace the blocking version, filesystem, YAML/CLI, XML and lazy-state
   dependencies with audited allowed code. Preserve signature and checksum
   verification, redirect/provider policy, cancellation, installer invocation,
   download caching and format-specific behavior. This is substantial security
   and maintenance work; no reviewed drop-in replacement was established here.
   Retargeting only `semver` or substituting a license label would not resolve it.

The existing targets are supported by
[electron-builder v26's updater](https://www.electron.build/v26/docs/features/auto-update/).
For paths two or three, require unit tests for failed/offline checks, simultaneous
checks, download consent, error recovery, and unsaved-document cancellation before
install. Require signed installed Windows/macOS and Linux target upgrade tests,
including architecture mismatch, corrupt downloads and invalid signatures. For
path one, verify fixed URL handling and menu behavior on packaged/development
builds, and document manual installation accurately.

After choosing and implementing a path, regenerate the runtime closure and inspect
each platform's packaged ASAR/dependency files to prove the rejected packages are
absent. They may remain development dependencies of packaging tools; the 38 missing
development grants remain informative unless those tools become redistributed.
Removing the npm blockers does not establish that Electron's separate binary
distribution meets the policy: its Chromium/Node/vendor notices require their own
review before the public-release gate can pass.
