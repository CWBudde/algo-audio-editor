# Electron binary notice audit — 2026-10-05

**The stock Electron runtime is not approved under the project's strict
MIT/BSD/Apache-only policy.** The npm package's MIT grant covers Electron's own
code; it does not turn Chromium, Node.js, FFmpeg or their embedded components
into MIT code. Keeping the original notices in an installer preserves evidence
but does not resolve the policy findings.

This audit inspected the installed Electron **44.5.1** distribution on a
**Linux x64** host. It read actual license text from `electron/dist`, rather than
using the npm `license` field as a proxy for the binary's licenses.

| Distribution artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `LICENSE` | 1,096 | `5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d` |
| `LICENSES.chromium.html` | 20,111,209 | `a62dabd1c6ef1327365b2a3fdffb806222684a746dcb8f4afd1c1f690eba5535` |

The HTML contains **779 product notice sections**, including duplicate names and
combined third-party grants. It also includes Android and Windows projects.
These notices are an attribution inventory, not proof that all 779 components
are linked into the Linux binary. This audit has not established a complete
per-platform set of included code or selected licenses.

## Concrete policy findings

The following rows identify actual sections and text inspected in the pinned
HTML. Line numbers refer to the original installed `LICENSES.chromium.html`,
whose full bytes are preserved by packaging. This table is a starting point for
replacement and exclusion work, not a complete list of every non-policy grant.

| Product section | First line | Inspected terms and remaining decision |
| --- | ---: | --- |
| `ffmpeg` | 86,868 | Its declaration specifies LGPL-2.1-or-later for the default combination and describes optional GPL parts. LGPL is outside the policy. The notice does **not** prove GPL options were enabled. Resolve the exact included source/build configuration and replace or exclude the affected component. |
| `AXE-CORE Accessibility Audit` | 22,422 | Full MPL-2.0 text. Establish distribution reachability and replace or prove exclusion. |
| `Eigen` | 69,871 | Full MPL-2.0 text. Establish distribution reachability and replace or prove exclusion. |
| `symphonia` and its bundled codec/common/core/metadata sections | 339,074 onward | Full MPL-2.0 texts. Establish distribution reachability and replace or prove exclusion. |
| `Braille Translation Library` | 24,474 | Source notice specifies LGPL-3.0-or-later. Establish distribution reachability and replace or prove exclusion. |
| `FreeType` (two sections) | 95,371; 95,551 | Full FreeType Project License (FTL), with its own attribution conditions; it is not one of the allowed SPDX licenses. Resolve actual included code and replacement/exclusion. |
| `hmac-sha256` | 144,905 | Full ISC license. ISC remains outside the confirmed policy. |
| `foldhash`; `zlib` (two sections) | 94,391; 359,441; 359,471 | Zlib grant and its three restrictions, outside the confirmed policy. |
| `icu` | 150,655 | Unicode License V3 followed by additional retained third-party notices. Its MIT-like permission wording does not change the grant to MIT or approve the additional notices. |
| `Node.js` | 181,297 | MIT core grant followed by embedded third-party grants, including ISC and other families. Review each retained component rather than selecting only the first MIT grant. |
| `Emoji` | 70,467 | Combined Apache text and SIL Open Font License 1.1 text. Android-specific section; Linux font reachability is not established by its presence here. OFL is outside the policy if those assets are distributed. |
| `dragonbox` | 68,727 | Contains Apache text with LLVM exceptions and Boost Software License text. Determine actual license choices and source scope; a lexical Apache match cannot approve exceptions or combined terms. |
| Ooura `2-dim General Purpose FFT…` | 23 | Custom short permission notice; no MIT/BSD/Apache identification is established. |

Disabling a UI feature, using Go codecs instead of Chromium codecs, or disabling
Node access in renderers does not establish that the corresponding third-party
code was removed from the distributed Electron runtime. Any exclusion needs
evidence from the actual distribution/build. Preserve notices during that work.

## Automated evidence and release gate

[`scripts/licenses-electron.mjs`](../../scripts/licenses-electron.mjs) exports
`collectElectronLicenses({root})`. It records the installed npm and binary
version match, host platform/architecture, both original artifact sizes and
digests, and every parsed product section. Each component has its original line,
duplicate occurrence number, SHA-256 of decoded `<pre>` license text, and lexical
`licenseFamilies` evidence tags. The complete 20 MB HTML stays in the installer;
it is not duplicated inline into the application notice asset or JSON inventory.

The tags are **not** approved SPDX expressions. For example, MPL text mentions
secondary GPL licenses; an FFmpeg declaration describes optional GPL build
settings; a combined notice can contain grants for different files. These
mentions must not be interpreted as selected runtime licenses. Twenty-four
sections have no recognized family tag at all, including custom FFT grants,
UnRAR, platform source notices, SQLite and other cases needing source review.
An absent tag does not approve the component.

The collector always retains a `binary-evidence` finding until the exact shipped
component reachability and selected grants have been reviewed against the strict
policy. Missing or empty artifact files, version mismatch, unrecognized notice
markup or unsupported entities retain an incomplete-evidence finding. The
combined strict audit must include these findings separately from Electron's
npm MIT entry, including in checks of the stored inventory. Collector regression
tests cover decoded evidence/digests, duplicate sections, malformed evidence,
missing files, version mismatch, and preservation of the runtime policy blocker.

## Replacement plan under the confirmed policy

The current evidence calls for one of the following, without broadening the
confirmed policy:

1. Prove a permitted license choice or actual exclusion for each affected
   component, using the precise sources and build configuration distributed.
2. Replace those components in a controlled runtime build and regenerate all
   notices and binary evidence, with acceptance on every distributed platform.
3. Replace the stock desktop runtime with a distribution that meets the policy,
   or limit a release to an independently audited target whose bundled code meets
   it. Browser distribution still requires the Go/WASM, font and npm findings in
   the [main audit](README.md) to be resolved.

No runtime replacement, custom Electron build, exact source/configuration audit
or installed Windows/macOS acceptance was completed here. The desktop release
license prerequisite remains open.

## Installer preservation

[`electron-builder.yml`](../../apps/desktop/electron-builder.yml) explicitly copies
the original files to `resources/licenses/LICENSE.electron.txt` and
`resources/licenses/LICENSES.chromium.html`; macOS uses
`Contents/Resources/licenses`. Explicit copies are needed because Electron
Builder removes the original archive-root files when repacking macOS. The
packaged smoke compares both copied artifacts byte-for-byte with the installed
distribution, in addition to the application notices available in About.
Installed platform acceptance is still tracked separately in Phase 19.
