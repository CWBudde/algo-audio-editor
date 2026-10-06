# FLAC candidate remediation (2026-10-06)

This is local upstream implementation work against the verified MIT
`github.com/tphakala/go-flac v1.1.0` archive. The editor still consumes its
existing tagged codec. No upstream issue, pull request, grant change, tag or
release has been published, and adoption (Phase 27) remains open.

The [initial evaluation](flac-evaluation.md) retains the original failures.
The [patch bundle](../../scripts/license-probes/flac-remediation/README.md)
retains the original upstream MIT grant and exact base, patch and resulting
source hashes. Product builds do not import these patches or the evaluator.

## Implementation

Three implementation subagents worked independently on stream validation,
metadata limits and encoder residuals. The fixes are kept in upstream source
paths, ready for review and submission to the candidate maintainer.

The packed PCM decoder rejects frame rate, depth and channel changes before
sample buffers grow. It checks frame/sample sequencing, blocking strategy,
maximum block size and declared sample counts independently of MD5. A short
last frame is allowed, while a successor makes it invalid. Errors remain sticky;
reset and seek behavior have regression coverage. FLAC itself permits some
changing audio properties, as described in
[RFC 9639 Appendix C.8](https://www.rfc-editor.org/rfc/rfc9639.html#section-appendix.c.8).
Rejecting these is an explicit limit of the fixed-format PCM API/editor adapter,
not a claim that every such stream is malformed.

Metadata parsing no longer allocates the declared SEEKTABLE body. It validates
entry divisibility before reading, reads complete 18-byte points incrementally,
and grows retained storage only after receiving complete entries. Metadata
limits include skipped blocks, headers and leading ID3 data. Skipping seek
points retains forward decoding and frame-search seeking.

`NewDecoderWithOptions` accepts `MaxMetadataBytes`, `MaxScratchBytes` and
`SkipSeekTable`. Zero values select 16 MiB of encoded metadata and 32 MiB of
retained decoder backing buffers; negative limits fail. The scratch budget
includes frame/sample workspaces, packed PCM, seek points, probe windows and
fixed read buffers, with preflight before growth. It excludes caller buffers,
Go object/allocator/runtime overhead and transient old buffers during growth.
It is a retained-buffer ceiling, not a process RSS limit or a substitute for
editor-owned reservations. Reset preserves options and buffer high-water marks.

The wide encoder now rejects fixed/LPC predictor candidates whose residuals
exceed signed 32-bit range or equal INT32_MIN, as required by
[RFC 9639 section 9.2.7.3](https://www.rfc-editor.org/rfc/rfc9639.html#section-9.2.7.3).
It chooses a valid predictor or verbatim encoding instead of emitting a file
accepted only by its own decoder. Constant INT32_MIN samples can still use
constant subframes. This adds work to the wide predictor search and can change
encoded size; full performance/size acceptance remains open.

## Reproduction

On Linux amd64 with Go, Node, git and libFLAC installed:

```sh
just evaluate-flac-remediated
just --command node scripts/flac-evaluation.mjs --remediated --output /tmp/flac-remediation.json
```

The evaluator verifies the original module checksum before copying its source
into a temporary directory, verifies the retained patch, applies it, and checks
resulting file hashes. The Go replace directive exists only in that temporary
evaluation module. It does not mutate the shared verified source cache, kernel
module files or production dependencies. Temporary sources, fixtures and binaries
are removed afterward; tagged dependency/toolchain downloads may remain cached.

A successful command means the evaluation completed, not that adoption passed.
The report retains any independent codec failures and an explicit adoption
block. Full per-file/contributor provenance, final SIMD/math reach, the IETF
corpus, bounded atomic editor imports/writers, one-hour memory/performance,
WASM/browser codec parity, installed platform and binary-budget acceptance
remain required, along with a reviewed upstream tag before consumption.

## Validation

The [retained checks and before/after JSON](../benchmarks/flac-remediation-2026-10-06.md)
record 512/512 independent PCM comparisons (versus 480/512), all 19 matching
native/WASM probes and under-128-KiB truncated-table allocation guards. Ten
upstream packages pass on each runtime, with external corpus/subprocess skips
retained. Native race, three fuzz smokes, 128 extra native encoder reference
cases and 22 offline evaluator guards pass. These checks do not establish the
remaining adoption gates.
