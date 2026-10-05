# Go math reach validation — 2026-10-06

Phase 23 diagnostic increment, baseline
`5ccc2484092066d4998eb3ed53357b2a7d358ab8`. The report records a dirty checkout
containing the new diagnostic/docs; the kernel and dependency inputs are unchanged.
The retained run spans **2026-10-05 23:40:35.847–23:42:43.167 UTC**
(2026-10-06 in Europe/Berlin). This is build/evidence collection, not a processing
performance benchmark or license approval.

[Full JSON evidence](go-math-reach-2026-10-06.json) retains all target commands,
source/graph/input/log/artifact fingerprints, selected declarations, file notices
and first-retention paths. [Reproduction and interpretation](../licenses/go-math-reach.md)
explain the limits. No product dependency, runtime math implementation, policy,
license text, bundled notice or release tag changed.

## Build and source evidence

Host: Linux amd64, Node **24.12.0**, Go **1.26.8**, installed Binaryen
**132.0.0**. `GOWORK=off`, `GOENV=off`, `CGO_ENABLED=0`, no build tags or
experiments, AMD64 v1 / ARM64 v8.0. Native builds use `-trimpath` without
stripping; WASM uses production stripping/stamps and the exact production
Binaryen flags. `-dumpdep`, `-mod=readonly` and `-buildvcs=false` are diagnostic
additions; these are not byte comparisons with existing product artifacts.

All **13 builds** pass: two native commands on six targets and one WASM kernel.
Counts below are **per command**, and both native commands have the same counts
on each target. Mapped symbols include ABI wrappers; file notices do not assign
individual function licenses or establish instruction-level provenance.

| Target | Commands | Retained math symbols | Symbols mapped to one source body | Mapped symbols associated with Sun/Cephes-noticed bodies |
| --- | --- | ---: | ---: | ---: |
| Linux amd64 | `aae`, `aae-mcp` | 74 | 45 | 22 |
| Linux arm64 | `aae`, `aae-mcp` | 56 | 38 | 21 |
| macOS amd64 | `aae`, `aae-mcp` | 74 | 45 | 22 |
| macOS arm64 | `aae`, `aae-mcp` | 56 | 38 | 21 |
| Windows amd64 | `aae`, `aae-mcp` | 74 | 45 | 22 |
| Windows arm64 | `aae`, `aae-mcp` | 56 | 38 | 21 |
| js/wasm | `kernel` | 49 | 39 | 24 |

Selected Go/assembly files match actual target `go list` output. An independent
review verified all **913 repeated selected-source hashes** against the pinned
toolchain, all seven script/build inputs and the **176-file** kernel snapshot.
The snapshot digest is
`d005479066cc23bb9a7855fd55931ba99c06364ef6ac34d8564702129d0b571f`.
`go mod verify` reports **all modules verified** before and after builds.
The runner rejects snapshot/input changes and uses temporary outputs, cleaned
after completion; raw logs/binaries are represented by hashes rather than retained.

## Positive retention and replacement scope

Every target retains the five previously identified generic bodies:

| First retaining DSP parent | Symbol | Selected source notice |
| --- | --- | --- |
| `Generator.Sine` | `math.sin` | Cephes, `sin.go` |
| `butterworthFirstOrderLP` | `math.tan` | Cephes, `tan.go` |
| `StreamGenerator.sample` | `math.expm1` | Sun, `expm1.go` |
| `Distortion.shapeSample` | `math.atan` | Cephes, `atan.go` |
| `Distortion.tanhShape` | `math.tanh` | Cephes, `tanh.go` |

The larger map additionally identifies complex filter-design/response paths:
`bandQuadraticRoots` retains `math/cmplx.Sqrt`, `arcJacSN` retains complex
Asin/Atan, and elliptic `CDE` retains complex Cos. Their selected files retain
Cephes wording and transitive scalar math. WASM also retains generic `math.exp`
through `math.pow`, and `math.log` through loudness measurement. The classifier
catches `exp.go`'s Sun copyright wording even without the `Developed at SunPro`
phrase.

Native `go-mp3` initialization also first retains `math.cos`; changing only DSP
callers cannot establish codec exclusion. Architecture-specific exp/log assembly
has its own source evidence; the absence of a Sun/Cephes header there does not
resolve inherited algorithm/constant provenance. First-retention paths do not
enumerate every caller, and absent out-of-line symbols do not rule out inlining.

## WASM artifact identity and the remaining attribution gap

The raw stripped WASM and its unstripped named companion have **identical
non-custom section bytes**. The named raw companion contains **5,633** function
names, of which **39** are math/complex math; these map through Go's exact name
sanitizer to retained symbols and selected declarations. The five generic bodies
above appear in this verified raw name map.

The actual optimized WASM is **10,741,902 bytes**, SHA-256
`8ce044d4bdacf331baffe2149a8947e7916cdb17d16835bc0a9af2cf86d9b7a5`.
Its non-custom digest is
`83b3ca7eec8f55864a4780d1f6221d5b683623b53c40e812cbd14c36fd38de9d`.
Production and named Binaryen passes took **58.407 s** / **58.253 s** on this
host; these durations are not acceptance thresholds or a speedup claim.

The optimized named companion differs in non-custom bytes. The runner records
`mappingAccepted: false` and **withholds every companion function name** from
final attribution. The actual optimized artifact contains zero function names.
All four raw/optimized WASM artifacts pass host `WebAssembly.validate`; product
functions are not executed. Full optimized symbol/source attribution remains open.

## Checks and limits

- **37 pure Node regressions pass**: strict linker parsing, retention-path
  ambiguities, body/declaration/assembly distinctions, source guards, malformed
  WASM sections/names, CLI/environment/snapshot isolation, sanitizer collisions
  and withholding names on optimized identity mismatch. They run through
  `just check-licenses` locally and its existing web CI invocation, without Go
  or network access.
- **Five Go notice-classification cases pass**, including Sun's 2004 wording
  and preserving Sun/Cephes evidence beside a Go BSD header. Standalone helper
  `go vet` passes.
- **20 existing inventory/policy tests and input freshness pass**. The strict
  release check fails as expected with the unchanged **12 runtime findings**:
  742 inventory entries, 61 runtime and 681 development.
- Formatting/import/lint checks on the four diagnostic scripts, repository
  formatting and whitespace checks pass. Report/input hashes were checked after
  formatting. Biome's bounded file limit is raised to 4 MiB so the retained
  2.4 MiB report is checked by formatting and commit hooks; its parsed content
  matches the original evaluator output exactly.

Commands:

```sh
just --command node scripts/go-math-reach.mjs --output /tmp/go-math-reach.json
just test-go-math-reach
GOWORK=off GOTOOLCHAIN=go1.26.8 just --command go test scripts/license-probes/math-reach/source-map.go scripts/license-probes/math-reach/source-map_test.go
GOWORK=off GOTOOLCHAIN=go1.26.8 just --command go vet scripts/license-probes/math-reach/source-map.go scripts/license-probes/math-reach/source-map_test.go
just check-licenses
just check-license-policy # expected failure; unresolved runtime findings
just check-formatted
```

Full editor CI, product browser/Electron playback tests, live deployment,
hardware timing, native Windows/macOS execution and signed/installed releases
were not rerun. Per-instruction/inlined/constant/assembly provenance, final
optimized attribution, numerical/performance contracts, upstream permitted math
implementations, tags and adoption remain open. The report establishes neither
policy compliance nor a reviewed drop-in math/toolchain replacement.
