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
committing does not imply permission to push or publish. Run checks appropriate
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
Required branch checks remain an open R.10 repository-setting task; the branch
protection API reported `Branch not protected` during the 2026-10-05 audit.

## First release

No application release has been tagged. `just check-unreleased` reports this
known state without failing; after a first tag, it checks accumulated commits
against the configured threshold. Do not tag only to silence that report.

Before selecting a release commit:

- Complete or explicitly decide the first-release feature scope. Phase S ties
  waveform-editor completeness to Phases 1–6 and the outstanding metadata/project
  work in Phases 16–17. Keep unfinished performance, browser and host acceptance
  visible in the roadmap.
- Complete Phase 23's Go/npm license audit and bundled third-party notices,
  including the documented FLAC Unlicense and archived AAC muxer decisions.
- Complete Phase 19's signing, installed associations, package integrity and real
  update acceptance. Configure Windows/macOS signing and macOS notarization
  credentials as described in [`desktop.md`](desktop.md#updates-and-publishing).
- Run `just check-deps`, `just check-unreleased` and full local `just ci` on the
  candidate. Document any deliberately deferred sibling version in `PLAN.md`.
- Obtain successful remote CI for that exact commit on `main`; an earlier green
  commit or a local run does not satisfy the publishing gate.
- Move the intended changelog entries into a dated release section and agree the
  version and release scope. The R.10 first-tag target is `v0.1.0`; using `v0.x`
  does not waive the release prerequisites.

Tagging and pushing a release tag is a publishing action. The `v*` workflow builds
installers, injects the tag version into the desktop manifest, and creates/uploads
a GitHub release after its gates pass. Only do this when publishing is authorized.
Verify the complete installers, updater metadata and blockmaps described in the
desktop guide, and check the deployed demo with `just e2e-pages-live` when Pages
publishing is part of the release.
