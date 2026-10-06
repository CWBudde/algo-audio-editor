# Benchmark and validation evidence

These reports preserve dated observations, commands and limits. They are not
claims that the current build meets every hardware or platform acceptance gate.
PLAN.md keeps unfinished requirements; source and commit history define what
was implemented. Historical temporary logs are not durable raw artifacts.

| Report | Scope | Status of related acceptance |
| --- | --- | --- |
| [Processing, 2026-10-03](processing-2026-10-03.md) | Full ten-minute processing sweeps, tagged optimizations, isolated gates and host load | Phase 15's complete <1 s matrix remains open |
| [Spectrogram playback, 2026-10-04–05](spectrogram-playback-2026-10-04-05.md) | Phase 5 pass, Phase 8/baseline failures and later R.5 pass | Historical discrepancy profiling remains open in Phase 15 |
| [Implementation validation, 2026-10-04–05](implementation-validation-2026-10-04-05.md) | Dated WAV/restoration/desktop/batch/MCP and browser-CI follow-up results | Platform, listening, metadata, release and MCP host gates remain separate |
| [R.5, 2026-10-05](r5-2026-10-05.md) | Native/V8/browser analysis, actual one-hour FLAC, history and playback | Local implementation evidence; broader Phase 15 acceptance remains open |
| [R.1 CI/lint, 2026-10-05](r1-ci-2026-10-05.md) | Native/WASM lint, action pins/caches/timeouts and repeated allocation/EOF checks | Both historical flakes remain unconfirmed; hosted workflow execution is separate |
| [Dependency notices, 2026-10-05](licenses-2026-10-05.md) | Pinned Go/npm/Electron source inventory, freshness/policy tests and actual browser/Pages/Linux package notices | Phase 23 runtime policy/evidence replacements remain open; no release approval |
| [Font/icon replacements, 2026-10-06](license-replacements-2026-10-06.md) | System typography, MIT icons, generated-component aliases, build exclusions and browser/Linux package checks | Font/icon findings cleared; remaining runtime policy/evidence and installed typography acceptance remain open |
| [FLAC evaluation, 2026-10-06](../licenses/flac-evaluation.md) | Pinned candidate/grant digests, seven-target compilation, native/WASM malformed-input probes and independent codec comparisons | Candidate adoption blocked by validation/allocation/32-bit encoding defects; full provenance and editor acceptance remain open |
| [FLAC remediation, 2026-10-06](flac-remediation-2026-10-06.md) | Verified local upstream patches, bounded decoder tests and independent reference comparisons | No upstream release/adoption; full provenance, corpus and editor acceptance remain open |
| [Go math reach, 2026-10-06](go-math-reach-2026-10-06.md) | Thirteen pure-Go builds, selected source declarations/notices, retention paths and verified raw WASM names | Optimized WASM attribution and permitted upstream math/toolchain replacements remain open |
| [Visual design, 2026-10-06](visual-design-2026-10-06.md) | Icon-inspired palette, adaptive waveform workspace, dialog review, retained screenshots and browser/Linux Electron checks | Phase 24 user feedback, exhaustive state review and installed platform/scale acceptance remain open |

R.5 additionally retains [analysis tool-output transcription](r5-analysis-2026-10-05.txt)
and [production browser JSON](r5-browser-2026-10-05.json). Earlier reports are
roadmap transcriptions; their exact original temporary logs are not archived here.

## Roadmap claim audit

Audited on **2026-10-05**, baseline **`1095644`**. This documentation-only audit
did not rerun historical benchmarks or certify a new hosted CI run.

- **First real CI:** the historical Phase 0/9 claims describe implemented
  workflows and local e2e. The Playwright install invocation previously failed
  before any CI e2e ran; [PR #1 / `b1531cf`](https://github.com/cwbudde/algo-audio-editor/commit/b1531cf)
  corrected it on 2026-10-04. Current `test-e2e.yml` installs browser/system
  dependencies from the app directory and runs browser, Pages, development
  Electron and packaged Electron recipes. Hardware `@timing` cases remain
  opt-in in `playwright.config.ts`; ordinary CI excludes them.
- **Spectrogram claims:** Phase 5's isolated pass and Phase 8's underrun reports
  refer to distinct runs. R.5 later passed the same production gate after
  bounded analysis scheduling. [All run narratives](spectrogram-playback-2026-10-04-05.md)
  remain visible, and Phase 15 still requires cause profiling and unchanged-gate
  acceptance. A newer pass alone does not explain the historical failures.
- **ABI:** `internal/protocol/protocol.go` and `packages/protocol/src/index.ts`
  both define **18** at the audit baseline. U.5/U.6's historical v10 was accurate
  at [UI acceptance commit `2a4531f`](https://github.com/cwbudde/algo-audio-editor/blob/2a4531f/packages/kernel/internal/protocol/protocol.go#L13);
  it is not a current-version claim. Documentation changes do not bump the ABI.
- **Counts and verification scope:** dated suite counts, coverage and asset sizes
  remain in reports as historical observations. Completed summaries state their
  checked scope and limits; a local `just ci` pass and a configured workflow do
  not establish hosted success for a later commit. CI runs must be matched to
  the intended commit; no latest hosted result was inferred during this audit.
- **Phase status:** phases with implemented behavior plus unfinished acceptance
  use “IMPLEMENTATION COMPLETE”; follow-up Phases 15–23 retain performance,
  metadata/persistence, listening, release/platform, caching, automation/MCP
  and license requirements. Phase 4's completed effect-update gate is distinct
  from Phase 3's incomplete full processing matrix. The [historical roadmap at
  `9de516f`](https://github.com/cwbudde/algo-audio-editor/blob/9de516f/PLAN.md)
  retains prior detail; the mapping table in current PLAN.md preserves IDs.
- **Process:** README's CI badge and `docs/images/editor-demo.png` already exist.
  `pages.yml` waits for successful main CI and builds the tested SHA;
  `desktop-release.yml` checks tag ancestry and successful CI for the resolved
  commit. Publication gates are distinct from repository branch/ruleset
  enforcement; the branch protection API reported `Branch not protected` in
  the root agent's 2026-10-05 audit. Rulesets were not audited; see the
  [release/process guide](../releasing.md). Required checks remain open. The user's direct-main
  instruction takes precedence over the old branch/PR preference. No tag,
  release or publication is part of this audit; first-release prerequisites
  and dependency/CI checks remain open.
