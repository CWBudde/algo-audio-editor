# FLAC remediation validation (2026-10-06)

Editor baseline: `fe23fb3f858ed47cca26c802559c86d4d4314505`.
Candidate: verified `tphakala/go-flac v1.1.0`, upstream tag commit
`41022d6b879fd3cc7703facec93e0af94f1b49c5`, plus the retained local patch.
Host: Linux amd64, Go 1.26.8, Node 24.12.0, libFLAC 1.4.3.
Three implementation subagents handled stream validation, metadata budgeting
and encoder residuals, then independently reviewed the combined changes.

[Baseline JSON](flac-remediation-baseline-2026-10-06.json) and
[patched JSON](flac-remediation-2026-10-06.json) use the same probe source hash.
The [manifest](../../scripts/license-probes/flac-remediation/manifest.json)
pins the archive identity, patch and all 13 resulting source-file hashes.
The evaluator checks these before compiling the isolated patched candidate.
Root grant evidence describes the verified baseline, not a new provenance verdict.

## Independent PCM comparison

Both runs compile Linux/macOS/Windows amd64/arm64 plus js/wasm: seven targets.
Only Linux amd64 and Node js/wasm execute; five native targets are compile-only.

The native independent matrix uses libFLAC in both directions, signed packed
PCM extrema/zero/nontrivial samples, 48 kHz, effort 5, depths 8/16/24/32,
channels 1–8 and lengths 1/15/16/31/4095/4096/4097/9000.

| Run | Exact PCM comparisons | Encoder failures |
| --- | --- | --- |
| Original v1.1.0 | 480/512 | 32, all 32-bit multi-block/near-block shapes |
| Local remediation | 512/512 | 0 |

The native upstream suite additionally requires libFLAC for 128 new independent
32-bit encoder cases: levels 0/3/5/8 × channels 1–8 × lengths 4095/4096/4097/9000.
Warm verbatim fallback remains allocation-free in its regression. The wide-path
predictor search does additional work; no end-to-end speed/size guarantee follows.
The baseline retains its FFmpeg rejection evidence. The passing remediation
matrix did not invoke FFmpeg as a second decoder.

## Decoder limits and behavior

All 19 probe outcomes match under native and Node WASM. Exact valid and
unknown-count PCM still passes; every mutation requiring rejection now returns
an error, including count/MD5 combinations and fixed-format incompatibilities.
Changing properties can be RFC-valid but is unsupported by this PCM API.
Upstream regressions also cover sequence/block rules, short final blocks,
reset/sticky errors, variable-block seeking, metadata/scratch caps, skipped and
duplicate seek tables and retained buffer reuse.

Each allocation row below comes from a 46-byte truncated input. Allocation is the
MemStats TotalAlloc delta after GC around construction/drain, not process RSS.

| Declared seek-table body | Original native allocation | Patched native | Patched WASM | Rejection path |
| --- | ---: | ---: | ---: | --- |
| Maximal 16,777,215 bytes | 16,786,464 | 11,640 | 9,976 | Cumulative metadata budget |
| Maximal divisible 16,777,206 bytes | 16,786,464 | 11,288 | 9,624 | Cumulative metadata budget |
| In-budget divisible 1,048,572 bytes | 1,057,824 | 9,376 | 9,376 | Incremental parser detects truncation |

The evaluator requires every patched allocation below 128 KiB. The upstream
metadata regression separately raises the metadata cap to 32 MiB and verifies
that a maximal divisible truncated table remains below 128 KiB, exercising the
incremental parser even when the outer byte budget permits the declaration.
Metadata divisibility and duplicate-table regressions check rejection before
body reads. Scratch caps cover retained backing buffers, excluding caller
buffers, runtime/object overhead and transient old/new storage during growth.
An adapter must still reserve storage before constructing a decoder.

## Actual checks

The evaluator runs complete patched upstream suites with `-count=1`, including
all checked-in fuzz seeds; external corpus tests remain skipped. Reported counts
are pass events including nested cases, not counts of top-level test functions.

| Execution | Passing packages | Passing test events | Skipped tests |
| --- | ---: | ---: | ---: |
| Linux amd64 | 10 | 1,005 | 5 |
| Node js/wasm | 10 | 849 | 11 |

Native skips are the external conformance/reencode corpus and optional full
reference-fixture suite. WASM additionally skips native subprocess codec tests,
including the new 128-case libFLAC test. Exact skip identities, commands,
durations and output hashes remain in the patched JSON. The Node runner uses
`env -i` to stay within Go WASM startup environment limits.

Native and js/wasm `go vet ./...` pass. Native `-race` passed for `./pcm ./internal/frame ./internal/meta` (5.566s,
1.904s, 1.015s respectively). Three native five-second, two-worker fuzz smokes
passed: metadata 322,303 executions, frame 280,909 and encoder 378. They ran
concurrently and are smoke evidence, not exhaustive malformed-input coverage
or throughput benchmarks; encoder completed after 6.007s.

22 offline argument/bundle guard tests pass, including wrong base/hash,
unsafe/duplicate paths and source drift. The 20 collector
and license freshness tests also pass; the unchanged product inventory retains
742 entries and 12 runtime release findings. `just check-license-policy` fails
as expected on those unchanged findings. `just fmt check-formatted`,
`git diff --check`, 80 local Markdown links and patch/source/report/grant
identity checks pass.

## Reproduction and limits

See [implementation/reproduction](../licenses/flac-remediation.md) and the
[patch bundle](../../scripts/license-probes/flac-remediation/README.md).
Run the evaluator on Linux amd64; it uses a temporary module and no product
replacement directive. No upstream issue, message, pull request, tag or release
was published. The editor codec, manifests, lockfiles and shipped notices are
unchanged. These changes cannot clear the FLAC/runtime release findings.

Full per-file/contributor provenance and linked SIMD/math reach, IETF corpus,
one-hour import/performance/storage, bounded atomic editor import/writers,
WASM/browser reference parity, installed platforms and final binary budgets
remain open. Seeking cannot validate skipped earlier frames, and a streaming
consumer can receive a valid prefix before a later error. Product adoption must
keep private candidates and publish only after complete validation.

Full editor CI, web/desktop/product Go suites, browser/Pages/package gates,
hardware timing and installed Windows/macOS acceptance were not rerun for this
isolated upstream/evaluator increment. A reviewed upstream tag is required
before changing the product dependency.
