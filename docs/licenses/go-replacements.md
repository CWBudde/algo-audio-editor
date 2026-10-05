# Go license remediation plan (2026-10-05)

The user chose to retain **MIT/BSD/Apache only** for bundled code. Keep the
current [audit findings](README.md#unresolved-evidence-and-policy) and strict
release gate until source replacements or verified grants resolve them. This
document plans follow-up work; it does not change dependencies, grant rights,
approve a release, or treat Unlicense as MIT.

## FLAC: evaluate a tagged MIT implementation first

The first candidate is
[`github.com/tphakala/go-flac v1.1.0`](https://github.com/tphakala/go-flac/tree/v1.1.0),
not another mewkiz-derived fork. Its tagged
[LICENSE](https://github.com/tphakala/go-flac/blob/v1.1.0/LICENSE) supplies MIT
terms. Its [provenance statement](https://github.com/tphakala/go-flac/blob/v1.1.0/THIRD_PARTY.md)
describes original codec work, algorithm references rather than copied Unlicense
code, and SIMD kernels imported from the same author's MIT project. That is
promising author-supplied evidence, not an independent provenance verdict.
Audit the tagged sources and contributions before adoption.

The tag resolves to commit `41022d6b879fd3cc7703facec93e0af94f1b49c5`;
Go's exact download reports
`h1:dyVNPFW+MVLzPvw1n3dEvBHPtKUMbQ5PHWvW/pxQMv0=`.
The tagged [go.mod](https://github.com/tphakala/go-flac/blob/v1.1.0/go.mod)
requires Go 1.26, `tphakala/simd v1.8.0`, `golang.org/x/sys v0.45.0` and a
ruleguard DSL dependency. Main already requires Go 1.27, so evaluating main
would change the toolchain scope unnecessarily. The
[SIMD grant](https://github.com/tphakala/simd/blob/v1.8.0/LICENSE) is MIT;
its [module graph](https://github.com/tphakala/simd/blob/v1.8.0/go.mod)
still needs a complete runtime/development audit. No dependency was added here.

The tagged [decoder](https://github.com/tphakala/go-flac/blob/v1.1.0/pcm/decoder.go)
exposes `pcm.NewDecoder(io.Reader)`, `Info()` and streaming `Read`, with
checksum/truncation validation at stream completion. The
[encoder](https://github.com/tphakala/go-flac/blob/v1.1.0/pcm/encoder.go)
exposes `pcm.NewEncoder(io.Writer, pcm.Config)`, `Write` and `Close`; it accepts
interleaved signed little-endian PCM, uses 4096-frame blocks, and finalizes
STREAMINFO/MD5 with a seekable sink. Its
[configuration](https://github.com/tphakala/go-flac/blob/v1.1.0/pcm/pcm.go)
supports rates, channels, bit depth, compression effort and declared sample
counts. These interfaces appear suitable for the existing bounded writer and
private import candidate, but they are not the current planar-frame API.

Follow-up implementation order:

1. In an isolated evaluation module, pin v1.1.0, verify its downloaded checksum,
   audit root and embedded grants plus its entire selected graph, and compile
   the codec on js/wasm and the native release targets. Verify generic fallback
   code actually compiles without cgo or unsupported SIMD. Raise the editor's
   `go` directive to 1.26 only as part of a reviewed adoption if required.
2. Adapt `internal/engine/codecs.go` to streaming packed PCM without moving
   conversion/DSP into JavaScript. Keep signed sample interpretation,
   frame/channel/depth validation, checksum verification, unified storage
   accounting and failure-atomic document installation. Charge decoder scratch
   and packed buffers before retaining them; reject malformed sizes before
   allocation. Preserve the existing metadata/annotation rejection until Phase
   16 implements explicit mapping.
3. Validate independent PCM results, not just self round trips: 1/15/16/31,
   4095/4096/4097 and multi-block tails; mono through eight channels; supported
   bit depths; extrema/zero; unknown and dishonest declared counts; corrupt
   CRC/MD5, truncated metadata/audio and huge metadata/frame declarations.
   Run the IETF conformance corpus with documented fixture licenses and an
   independent reference decoder. Preserve one-hour import/storage and bounded
   writer failure regressions, plus native/WASM/browser export acceptance.
4. Remove all current FLAC imports and runtime reach, tidy the graph, regenerate
   notices, and rerun the strict license gate. `icza/bitio` can disappear only
   if no remaining dependency requires it. Compare memory, import/export time,
   encoded size and binary budgets against the existing implementation before
   marking the replacement complete.

The search did not establish a fully validated drop-in replacement. Another
candidate, [`takafumiokamoto/flac v0.1.1`](https://github.com/takafumiokamoto/flac/tree/v0.1.1),
has an [MIT grant](https://github.com/takafumiokamoto/flac/blob/v0.1.1/LICENSE)
but documents a [decoder API](https://github.com/takafumiokamoto/flac/blob/v0.1.1/README.md)
and [requires Go 1.27](https://github.com/takafumiokamoto/flac/blob/v0.1.1/go.mod).
It does not establish an encoder replacement and is not the first candidate.
[mewkiz/flac](https://github.com/mewkiz/flac) remains Unlicense, so reverting to
the original lineage does not solve this policy finding.

If no candidate passes, implement a separately audited Go codec upstream from
the format specification with original MIT/BSD/Apache code, conformance and
malformed-input tests, then tag it before consumption. BSD-licensed
[libFLAC](https://github.com/xiph/flac) and its
[Xiph grant](https://github.com/xiph/flac/blob/master/COPYING.Xiph) can be an
independent reference or an explicitly attributed source for a licensed port,
subject to per-file provenance review. The C library is not a drop-in Go/WASM
dependency; a cgo-only path would split the platform-independent engine. Do not
bundle its GPL command-line programs or transfer their license to the library.
Changing the current fork's LICENSE without resolving inherited rights is not
an approved replacement path.

## Missing algo-* grants: repair evidence upstream before new tags

`algo-vecmath v0.1.3` is in runtime reach. Its tagged
[README](https://github.com/cwbudde/algo-vecmath/blob/v0.1.3/README.md)
links to a LICENSE absent from the module archive. `algo-approx v0.2.0`'s
[README](https://github.com/cwbudde/algo-approx/blob/v0.2.0/README.md) declares
MIT without supplying full terms; it is development scope in this audit's
target union, so that evidence gap is retained without independently blocking
the runtime release gate.

First trace contributor ownership and external/ported source provenance in
both repositories, including SIMD assembly and reference files. The rights
holders must confirm the intended grant and supply full license text and
inherited notices for the covered code. A repository owner name or the
editor's own MIT grant does not establish those rights. Publish a new tagged
release containing the verified evidence, release affected upstream dependents
in dependency order where needed, then bump and regenerate here. This plan
does not issue that grant or contact contributors.

If a grant cannot be established, replace the affected kernels upstream with
original or independently audited permitted implementations. Keep all DSP in
the algo-* family, with architecture/generic equivalence, aliasing, numerical
accuracy and zero-allocation tests before tagging. A scalar replacement may be
a safe first implementation, but benchmark it against existing requirements;
dropping SIMD or changing approximation accuracy is a behavioral change.

## Go math: positive linked evidence, then scoped replacements

The initial audit conservatively inventoried selected package sources and
therefore could include functions removed by the linker. Before proposing a
toolchain replacement, actual Go 1.26.8 linker reach was checked for Linux
amd64 `aae`, `aae-mcp` and the js/wasm `cmd/kernel` using `-ldflags=-dumpdep`,
`-trimpath` and `CGO_ENABLED=0`. The linker marks reachable symbols in
[`deadcode.go`](https://github.com/golang/go/blob/go1.26.8/src/cmd/link/internal/ld/deadcode.go).
The following positive edges occurred in all three builds:

| Upstream caller | Retained math symbol | Embedded source terms |
| --- | --- | --- |
| `dsp/signal.(*Generator).Sine` | `math.sin` | Cephes/Stephen L. Moshier |
| `dsp/filter/design/pass.butterworthFirstOrderLP` | `math.tan` | Cephes/Stephen L. Moshier |
| `dsp/signal.(*StreamGenerator).sample` | `math.expm1` | SunPro |
| `dsp/effects.(*Distortion).shapeSample` | `math.atan` | Cephes/Stephen L. Moshier |
| `dsp/effects.(*Distortion).tanhShape` | `math.tanh` | Cephes/Stephen L. Moshier |

The WASM build additionally retained `math.log` from the loudness meter and
`math.exp` from `math.pow`. Source notices in
[sin.go](https://github.com/golang/go/blob/go1.26.8/src/math/sin.go) and
[expm1.go](https://github.com/golang/go/blob/go1.26.8/src/math/expm1.go)
show why these symbols carry the current findings. This proves specific
positive reach rather than removal of every unused source notice. It is not
an exhaustive symbol-to-license map, native platform acceptance, or analysis
of Binaryen's final optimized WASM output. Diagnostic executables were written
only under `/tmp`; product artifacts and dependency inputs were unchanged.

Reproduce the native diagnostic with:

```sh
CGO_ENABLED=0 just --command go -C packages/kernel build -trimpath -ldflags=-dumpdep -o /tmp/aae-license-reach ./cmd/aae
```

Run separately for `./cmd/aae-mcp` and with `GOOS=js GOARCH=wasm` for
`./cmd/kernel`; capture both stdout and stderr because Go forwards linker
diagnostics. Record the baseline commit, exact toolchain, target and build flags
with future candidate evidence.

The next implementation is a full symbol/source mapping for all seven release
targets and the final optimized WASM, followed by a bounded replacement spike:
implement required permitted transcendental functions upstream, change the
actual algo-dsp callers, tag upstream releases and compare correctness/render
allocation/performance. Do not mechanically replace `math` with `Fast*`
approximations: edge cases, range reduction, subnormals, signed zero, overflow,
NaN/infinity and precision requirements need explicit contracts and regression
vectors. Re-run the linker map after each dependency bump; removing direct
calls does not prove transitive standard-library calls disappeared.

If required SunPro/Cephes bodies remain reachable through Go's standard library,
this policy needs separately licensed replacement implementations in a
maintained Go toolchain build, with reproducible source/patch hashes, runtime
tests and build-system integration. Investigate that only after the reach and
upstream-caller work; the research has not identified a proven compatible
toolchain/math substitute. An ordinary toolchain upgrade, an alternate Go
compiler, or deleting notice entries is not evidence that those bodies or
obligations vanished. Keep the release blocked until the final artifacts and
regenerated notices meet the unchanged policy.
