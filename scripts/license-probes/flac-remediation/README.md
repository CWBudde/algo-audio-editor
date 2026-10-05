# Local upstream FLAC remediation bundle

These patches target `github.com/tphakala/go-flac v1.1.0`, tag commit
`41022d6b879fd3cc7703facec93e0af94f1b49c5`, module checksum
`h1:dyVNPFW+MVLzPvw1n3dEvBHPtKUMbQ5PHWvW/pxQMv0=`.
They are evaluation-only upstream source changes and regressions. Product builds
never import them; they do not establish a new release or adoption approval.

- [robustness.patch](robustness.patch) contains decoder/frame preflight,
  bounded metadata/options, legal wide encoder residuals and regression tests.
- [manifest.json](manifest.json) pins the base identity, patch SHA-256 and
  resulting hashes for all 13 changed or added Go files.
- [LICENSE.upstream](LICENSE.upstream) preserves the exact upstream MIT grant
  and Tomi P. Hakala copyright notice, including copied patch context/source.
  The original additions are provided under this repository’s MIT grant.

The patch uses zero context; the evaluator verifies the original archive digest
before application and the resulting file hashes before compilation. Apply with
`git apply --check --unidiff-zero robustness.patch`, followed by
`git apply --unidiff-zero robustness.patch`, only to a fresh copy of that verified
archive. Never patch the shared module cache or product dependency tree.

On Linux amd64 with Go, Node, git and libFLAC available, run from the editor root:

```sh
just evaluate-flac-remediated
just --command node scripts/flac-evaluation.mjs --remediated --output /tmp/flac-remediation.json
```

The temporary source includes its own tagged dependencies and original grant.
The evaluator preserves base module/grant evidence separately from patched-file
hashes, compiles seven targets, runs native/Node-WASM upstream tests and compares
PCM with an independent codec. No code components were copied from the RFC;
the format requirements informed the original fixes.

[Implementation, limits and adoption gates](../../../docs/licenses/flac-remediation.md)
and [retained validation](../../../docs/benchmarks/flac-remediation-2026-10-06.md)
record the exact scope. Source paths remain those of the upstream candidate so
these fixes can be reviewed and submitted without a local DSP/codec copy in the
editor kernel. No upstream contributor contact or publication has occurred.
