# npm dependency audit

The collector in `scripts/licenses-npm.mjs` audits the exact name/version identities
in Bun's version 2 text lockfile, including nested resolutions and platform optional
packages. It does not evaluate lockfile code. Workspace manifests must match the
lockfile, and installed direct dependencies must match its exact versions.

Runtime scope covers the web application's dependencies and their dependency/peer
closure, plus the desktop `electron-updater` closure. `shadcn` contributes its
imported `tailwind.css`, so its package is runtime while its component generator's
CLI dependency tree is development. `tailwindcss` contributes generated stylesheet
code even though it is a development declaration. Electron itself is runtime;
the npm package's downloader dependencies are development. Electron's binary
distribution has additional attribution handled separately during packaging.
This inventory is conservative at the package level, rather than a claim that
every file of each runtime package is in a production bundle. Generated shadcn
components use that project's MIT grant; Base UI primitives are inventoried under
`@base-ui/react` and its dependencies. Geist font files are marked as assets.

License evidence retains complete shipped LICENSE, COPYING, COPYRIGHT and NOTICE
files, with exact text and SHA-256 digests. A README license section is accepted
only when it contains a full grant, rather than an SPDX label or link. Installed
sources are validated by manifest name/version; their stored integrity identifies
the expected lockfile artifact and does not assert a hash of the installed tree.

Missing packages and packages that omit license text are fetched from the npm
registry as archives. Every archive must match the lockfile's integrity before
extraction and must contain the expected package identity. No package scripts
execute, and this does not install or change dependencies. Where the archive
omits its grant, upstream text is accepted only at the immutable Git commit
recorded by the exact npm release whose registry integrity matches the lockfile.
Such texts retain their source URL, revision and release metadata URL. Unavailable
sources or missing texts remain explicit findings, including packages unavailable
on the audit host. An offline collector run never fills a missing grant from an
inferred SPDX template.

On 2026-10-05 the lockfile had 759 package keys representing 715 distinct external
name/version identities: 42 runtime and 673 development. The audit covered 69
platform-restricted identities; 62 packages were not installed on this Linux host
and were read from verified registry archives. It retained 694 license/notice
texts totaling 1,523,818 bytes. There were 38 development packages without full
license text and one runtime package without a grant: `lazy-val@1.0.5`. Its
published archive declares MIT but omits a license, and its release commit
`b69ad4119f1b19bdab13c61ee2fcc88d46b89071` also has no LICENSE or COPYING file.
The collector preserves that finding rather than generating an assumed grant.

The declared runtime licenses exceed the roadmap's original MIT/BSD/Apache-only
policy: Geist uses OFL-1.1; `argparse` uses Python-2.0; `graceful-fs`, `lucide-react`
and `semver` use ISC; `sax` uses BlueOak-1.0.0. These are actual inventory findings,
not an approval to widen the policy. Development scope also includes licenses
such as MPL-2.0 and CC-BY-4.0; that does not imply those packages ship in the app.
The generated manifest is the authoritative per-version evidence.

Seven Node tests exercise JSONC parsing, scoped/nested resolution, runtime and
development separation, exact-version inventory and deduplication, optional
platform gaps, full copyright/notice retention, missing-license failures, and
stale installation or lockfile drift. They run through `just --command node --test
scripts/licenses-npm.test.mjs`.
