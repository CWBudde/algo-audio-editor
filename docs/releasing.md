# Contribution and release process

Use small Conventional Commits with a body explaining the behavior, relevant
validation and remaining limits. Update `PLAN.md` only for work actually completed
and describe user-visible changes under `CHANGELOG.md`'s Unreleased section.
Historical test counts and timings belong in dated reports under
[`docs/benchmarks`](benchmarks/), with the measured commit and environment when
available. A local passing run does not establish remote CI or installed-platform
acceptance.

## Changes and CI

Use a branch and pull request for normal contributions. An explicit request to
commit directly to `main` takes precedence for an agent's authorized work;
committing does not imply permission to push or publish. Never push onto a red
`main` or bypass the lefthook pre-commit/pre-push hooks there; interactive design
sessions use a branch that merges only once CI is green. Run checks appropriate
to the change through `just`; `just check` is the fast local gate, and `just ci`
also runs V8/WASM, fuzz, browser, Pages, Electron and packaged Linux checks.
Headless Linux needs a display wrapper:

```sh
xvfb-run --auto-servernum just ci
```

Hardware timing gates are separate: run `just e2e-timing` and the browser benchmark
recipes in isolation on the target laptop. They are not shared-runner CI gates.

The `CI` workflow runs on pull requests and pushes to `main`. Pages builds the
exact successful push-run commit; a manual Pages deployment also checks CI for
its commit. Desktop releases require a tag's commit to be on `main` and have
successful CI, then publish only after every platform build succeeds. A manual
desktop workflow checks its commit's CI and creates artifacts without publishing.
These workflow gates do not establish required checks for merging to `main`.
Required branch checks remain an open repository-setting task (PLAN Phase 29); the branch
protection API reported `Branch not protected` during the 2026-10-05 audit.

External workflow actions are pinned to verified commits with release comments;
update the SHA and comment together. `test-lint.yml` pins golangci-lint to
`v2.12.2`; use that version locally for `just lint-go` and staged-Go checks.
Both native and `js/wasm` targets use the same revive, errorlint and gosec rules.
The shared setup caches Bun downloads and Playwright Chromium, while always
running the frozen workspace install and requested browser/system install.
Cache hits do not replace validation or installation.

## Versioning and dependencies

- SemVer `v0.x` until the waveform editor (Phases 1–6 plus the metadata and
  project work in PLAN Phases 17–18) is complete. `CHANGELOG.md` follows Keep a
  Changelog.
- This is an application, not a library: `gorelease` API checks do not apply,
  but the algo-* family's dependency rules do. `just check-deps` must be green
  before a release; record any deliberately deferred sibling bump in `PLAN.md`.
- Upstream DSP work flows up the dependency graph: implement in `algo-dsp`, tag
  it there with `just tag-release`, then bump it here. Never pin a pseudo-version.

## First release

No application release has been tagged. `just check-unreleased` reports this
known state without failing; after a first tag, it checks accumulated commits
against the configured threshold. Do not tag only to silence that report.

`v0.1.0` is a **development release** (decided 2026-10-08): the web build
plus unsigned desktop artifacts, labelled as development builds. Signed
installers and installed-update acceptance (PLAN Phase 19) gate **1.0**, not
`v0.1.0`. The tagged desktop workflow currently forces code signing, so allow an
explicitly marked unsigned development build before tagging `v0.1.0`, without
weakening the signing requirement for 1.0 tags.

Before selecting a release commit:

- Complete the PLAN "Critical path to v0.1.0": green `main` and gate discipline
  (Phase 29), data safety and basics (Phase 30), autosave and crash recovery
  (Phase 18, project container optional), metadata (Phase 17), kernel and
  playback robustness (Phase 31) and the Phase 28 flakes. Keep unfinished
  performance, browser and host acceptance visible in the roadmap.
- Pass the revised, property-based license policy (Phase 27). The
  [current audit](licenses/README.md) supplies inventory/notices; accepted
  exceptions must be reviewed and recorded. After dependency or policy changes,
  run `just licenses`, review its evidence and commit regenerated files. Run
  `just check-license-policy` on the candidate; tagged desktop builds enforce this
  gate before packaging. `just check-licenses` in ordinary CI checks freshness and
  does not approve known findings.
- For 1.0, additionally complete Phase 19's signing, installed associations,
  package integrity and real update acceptance. Configure Windows/macOS signing
  and macOS notarization credentials as described in
  [`desktop.md`](desktop.md#updates-and-publishing).
- Run `just check-deps`, `just check-unreleased` and full local `just ci` on the
  candidate. Document any deliberately deferred sibling version in `PLAN.md`.
- Obtain successful remote CI for that exact commit on `main`; an earlier green
  commit or a local run does not satisfy the publishing gate.
- Move the intended changelog entries into a dated release section and agree the
  version and release scope. The first-tag target is `v0.1.0`; using `v0.x`
  does not waive the release prerequisites.

Tagging and pushing a release tag is a publishing action. The `v*` workflow builds
installers, injects the tag version into the desktop manifest, and creates/uploads
a GitHub release after its gates pass. Only do this when publishing is authorized.
Verify the complete installers, updater metadata and blockmaps described in the
desktop guide, and check the deployed demo with `just e2e-pages-live` when Pages
publishing is part of the release.
