# npm replacements under the existing license policy

Research date: 2026-10-05. The user chose to retain MIT/BSD/Apache-only bundled
dependencies and plan replacements. This document proposes implementation work;
it does not change dependencies, declare exceptions equivalent to allowed licenses,
or claim the first-release gate has passed. The current per-version evidence is
in [the dependency manifest](dependencies.json) and [npm audit](npm-audit.md).

## Replace the redistributed font

`apps/editor-web/src/index.css` imports `@fontsource-variable/geist` and sets
`--font-sans` to `Geist Variable`. Remove that import and dependency, and use a
local font stack such as `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
sans-serif`. This avoids shipping the OFL font files. The CSS specification
defines `system-ui` using the platform's default UI font; naming locally installed
fonts does not add their files to the app. This is a proposed implementation
inference from the [CSS Fonts specification](https://drafts.csswg.org/css-fonts-4/#system-ui-def).

Before completion, rebuild and verify that no Geist font assets, `@font-face`
rules or font network requests remain in the production build. Exercise the
1920×1080 effect dialog, menus, timeline labels and narrow-window layout, since
font metrics change. Check Linux plus installed Windows/macOS typography; a
Linux screenshot cannot establish those platforms' acceptance. Regenerate the
lockfile and notices with Bun 1.4.2, preserving exact installed versions.

## Replace Lucide glyphs and component types

The current source imports 31 glyph symbols and the `LucideIcon` type across 13
files, including `icon-action.tsx`, toolbars, waveform controls and three generated
shadcn files: `ui/sonner.tsx`, `ui/menubar.tsx` and `ui/dropdown-menu.tsx`.
`lucide-react@1.50.0` declares ISC. Its own
[upstream license](https://github.com/lucide-icons/lucide/blob/main/LICENSE)
also preserves Feather-derived attribution; copying its paths into local SVGs
does not turn them into newly licensed artwork.

Use an application-owned icon module backed by a small subset of Heroicons
outline SVGs, recording each upstream filename, release and content digest.
Heroicons v2.2.0 has a
[complete MIT grant](https://github.com/tailwindlabs/heroicons/blob/v2.2.0/LICENSE)
from Tailwind Labs. Alternatively, use the tagged `@heroicons/react` package;
its [versioned manifest](https://github.com/tailwindlabs/heroicons/blob/v2.2.0/react/package.json)
has a React peer and no declared runtime dependency tree. Verify the actual
selected package archive and license when implementing either option. Retain the
full grant and copyright in generated notices; add vendored sources to the audit
input/digest inventory if choosing local SVGs.

Map semantic actions rather than reproducing Lucide geometry: play→play,
stop→stop, copy→document duplicate, paste→clipboard, undo/redo→U-turn arrows,
loop→arrow path, zoom→magnifying glass, markers→flag, history→clock, and
warnings/info/checks→their matching status glyphs. For specialized controls such
as magnet snapping, crop selection or scan search, choose a distinct available
glyph or draw original geometry; retain accessible labels as the primary action
names. Define the app's icon prop type with React SVG props so `IconAction` does
not depend on `LucideIcon`.

The generated shadcn components need a reproducible generation/adaptation strategy
that respects the repository's generated-file convention. Resolve this before
removing Lucide: regenerating unchanged Lucide templates would reintroduce the
dependency. Test icon sizing/currentColor, keyboard focus, disabled actions,
`aria-hidden` and named buttons; run existing toolbar, waveform, menu and toast
tests and browser accessibility checks. Search both production imports and the
output bundle for Lucide, then update the lockfile and notices.

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
