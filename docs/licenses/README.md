# Dependency licenses and third-party notices

Phase 23's inventory and notice distribution are implemented. **Release approval
remains open**: the current dependencies exceed the roadmap's MIT/BSD/Apache
policy, and several pinned sources omit license grants. The user confirmed on
2026-10-05 that this policy stays in force and affected dependencies should be
replaced. The 2026-10-06 continuation replaced bundled Geist/Lucide with system
fonts and pinned MIT Heroicons; no dependency was relicensed.

The [Go audit](go-audit.md) covers 27 selected external modules and Go 1.26.8,
including the native CLI/MCP commands on six OS/architecture combinations and
the js/wasm kernel. The [npm audit](npm-audit.md) covers all 714 exact external
package versions in `bun.lock`, including uninstalled platform dependencies.
Together there are 742 inventory entries: 61 conservatively classified runtime
and 681 development entries. Runtime classification describes dependency reach,
rather than a claim that every package file survives production tree shaking.

[`dependencies.json`](dependencies.json) contains exact identities, scopes,
source evidence, license texts and SHA-256 text digests. The generated
[`third-party-notices.txt`](../../apps/editor-web/public/third-party-notices.txt)
includes runtime grants and embedded copyright/permission notices. About / Status
loads this local asset only when **Third-party notices** is requested; it is
available in browser, Pages subpaths and packaged Electron without navigating to
an external site. Generated data is checked in so builds do not need to crawl
registries or copy developer-specific module-cache paths.

Electron/Chromium attribution is additionally preserved in
`resources/licenses/LICENSE.electron.txt` and
`resources/licenses/LICENSES.chromium.html`. On macOS these are under the app's
`Contents/Resources`. Explicit packaging copies are necessary because Electron
Builder removes the original archive-root licenses when repacking macOS.
The Linux packaged regression compares these files against the installed Electron
distribution and reads the application notices through `app://`. Windows/macOS
installed acceptance remains Phase 19.

The [Electron binary audit](electron-audit.md) additionally records 779 product
notice sections and artifact/component digests from the installed Linux x64
runtime. `dependencies.json` retains this under `externalNotices`; the strict
gate includes its unresolved license-selection/platform-reachability finding.
Electron's npm MIT grant does not clear Chromium/Node/FFmpeg component terms.
The full 20 MiB HTML remains in the installer, outside the bounded application
notice viewer. A notice section is not proof that its component is linked on
every platform, and lexical license tags do not choose among alternative grants.

## Regeneration and checks

Run commands from the repository root, after the frozen workspace installation:

```sh
just licenses             # read exact sources, regenerate inventory and notices
just check-licenses       # collector tests, input freshness and notice consistency
just check-license-policy # same inventory check, fail on runtime findings
```

Regeneration uses the pinned Go toolchain and installed npm sources. Missing npm
sources or grants are sought in integrity-verified registry archives and, where
available, their exact release commit. No install scripts run during collection.
Go module downloads use temporary module-file copies; collection leaves `go.mod`,
`go.sum` and `bun.lock` unchanged. Review changes to identities, licenses, scopes,
texts, source evidence and findings before committing regenerated files.

The lightweight check performs no registry downloads and does not require Go.
It verifies hashes of dependency manifests/locks, policy and collector scripts,
every exact external Bun identity, all declared Go requirements and the pinned
toolchain. It also rejects duplicate identities, verifies text digests and checks
the generated notice bytes. It does not rerun the Go target graph or independently
prove copyright provenance: regenerate for an exact-source audit. Retained Go
entry issues are rederived during every strict check, so a missing grant is not
cleared merely by editing the summary findings.

`just check`, `just ci` and the web lint CI job run `check-licenses`. Tagged desktop
builds additionally run the strict policy gate before packaging/version injection.
Ordinary development and manual packaging keep existing findings visible without
claiming release approval. A successful freshness check means the reviewed
inventory matches current inputs; it does not mean all licenses are permitted.

## Unresolved evidence and policy

The original policy is explicit in [`policy.json`](policy.json): MIT, Apache-2.0
and BSD one/two/three-clause licenses. SPDX `OR` allows a permitted choice; `AND`
requires every obligation. Unknown expressions and unsupported `WITH` exceptions
fail closed. Font allowances are separate from code allowances.

The concrete runtime exceptions needing replacement or proven exclusion are:

| Dependency | License outside the current policy |
| --- | --- |
| cwbudde/flac v0.1.0 | Unlicense |
| Go 1.26.8 math | SunPro and retained Cephes free-use wording (`LicenseRef-Cephes`) |
| argparse 2.0.1 | Python-2.0 |
| graceful-fs 4.2.11, semver 7.7.4 | ISC |
| sax 1.6.1 | BlueOak-1.0.0 |

Missing or inconsistent source evidence also remains open:

- `algo-vecmath v0.1.3` has no root grant in its module archive; `algo-approx
  v0.2.0` declares MIT in its README but omits the full grant. The latter is
  development scope in the audited target union.
- FLAC's Go-derived CRC sources reference BSD terms in `LICENSE`, but the
  published module supplies only Unlicense there. Preserve and resolve the
  inherited BSD text upstream rather than replacing those notices.
- `lazy-val 1.0.5` declares MIT but supplies no full grant in its archive or
  recorded release commit. It is in the desktop updater's runtime closure.
- 38 development packages omit full license text; their identities, declared
  licenses and inspected sources remain in the manifest's findings. An SPDX
  label is not substituted for a missing grant.

The archived `mp4-muxer 5.2.2` has an actual MIT grant included in the notices.
Its successor's MPL-2.0 does not silently replace it; the maintenance decision and
codec limits remain in [the codec guide](../codecs.md#lossy-export).

Development-only missing grants remain informational; they are not silently
included in the shipped notice file or treated as a bundled-code restriction.
Runtime evidence/policy findings and unresolved finding identities block the
strict gate. Build tools that emit or redistribute third-party code/assets must
be classified runtime, regardless of their package manifest's dependency field.

System fonts and MIT Heroicons have replaced the redistributed Geist/Lucide
dependencies. The regenerated inventory/notice asset includes Heroicons' full
MIT grant and removes the old font/icon texts; there are now 12 runtime findings,
including overlap. See [replacement validation](../benchmarks/license-replacements-2026-10-06.md).

The [Go replacement plan](go-replacements.md) evaluates a tagged MIT FLAC
candidate, verified upstream grants and linked math replacements. The
[initial isolated FLAC report](flac-evaluation.md) records adoption blockers and
retained cross-target/reference evidence; the product codec is unchanged. The
[npm replacement report](npm-replacements.md) records the font/icon changes
and proposed updater tradeoffs. The [Electron plan](electron-audit.md#replacement-plan-under-the-confirmed-policy)
requires actual component reach/license selections and then a compliant runtime
build or shell replacement if needed. Codec/updater/toolchain and Electron
runtime replacements remain open; no license exception or runtime architecture
change was approved.

Complete the evidence fixes in tagged upstream releases or replace affected
dependencies under the confirmed policy before clearing Phase 23. The strict
command currently fails as intended. This audit does not
grant rights absent from upstream sources or approve a public release.
