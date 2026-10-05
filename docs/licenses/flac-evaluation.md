# Isolated MIT FLAC evaluation (2026-10-06)

**Do not adopt `github.com/tphakala/go-flac v1.1.0` yet.** The candidate builds
on every required target and passes the editor's currently supported 8/16/24-bit
export shapes in this limited independent matrix. Its decoder nevertheless
violates the editor's declared-count and frame-format import invariants and
allocates a large metadata buffer before detecting a tiny truncated input.
Independent decoders also reject some of its advertised 32-bit output. The
product's codec dependencies and strict license policy remain unchanged.

The [local remediation increment](flac-remediation.md) retains fixes and
regressions against this exact archive. It does not change these historical
v1.1.0 findings or establish an audited upstream release.

The [machine-readable evidence](../benchmarks/flac-evaluation-2026-10-06.json)
records module/grant hashes, per-target module reach, all malformed probes and
each failed independent comparison. This completes an initial feasibility
probe, not the full provenance, conformance, storage or performance acceptance
in the [replacement plan](go-replacements.md#flac-evaluate-a-tagged-mit-implementation-first).

## Reproduction and isolation

Run `just evaluate-flac` on Linux amd64 with Go tooling, Node and `flac`
available. The optional second decoder is `ffmpeg`. To retain a new report:

```sh
just --command node scripts/flac-evaluation.mjs --output /tmp/flac-evaluation.json
```

The script copies [its original probe](../../scripts/license-probes/flac-probe.go)
to a fresh temporary module outside the editor, sets `GOWORK=off`,
`GOTOOLCHAIN=go1.26.8`, `CGO_ENABLED=0`, pins v1.1.0, verifies the candidate's
expected module digest and runs `go mod verify` after downloading the whole
selected module graph. It removes temporary source, fixtures and executables
after completion; the shared Go download cache may gain these tagged modules.
It never edits the kernel's `go.mod`/`go.sum` or product dependencies.

The command is opt-in and may download sources/toolchains. It is absent from
default checks and release builds. Successful command exit means the evaluation
report completed; inspect its failures and adoption decision. Four offline
argument regressions reject malformed CLI arguments before any external tool
runs. Assertions require identical Linux/Node-WASM malformed-input behavior,
valid output and detection of the corruption/truncation controls.

## Build and grant evidence

All seven `-trimpath -buildvcs=false` builds succeeded: Linux, macOS and Windows
on amd64/arm64, plus js/wasm. Only Linux amd64 and js/wasm under Node were
executed. This does not establish installed macOS/Windows, browser or SIMD
runtime acceptance. Node's Go WASM launcher uses a reduced environment to fit
its argument/environment area.

The candidate's tag resolves to
`41022d6b879fd3cc7703facec93e0af94f1b49c5`; its verified module digest is
`h1:dyVNPFW+MVLzPvw1n3dEvBHPtKUMbQ5PHWvW/pxQMv0=`. Root evidence is:

| Selected module | Version | Observed root terms | Probe scope |
| --- | --- | --- | --- |
| `tphakala/go-flac` | v1.1.0 | MIT | Runtime, all targets |
| `tphakala/simd` | v1.8.0 | MIT | Runtime, all targets |
| `golang.org/x/sys` | v0.45.0 | BSD-3-Clause | Runtime, native targets |
| `quasilyte/go-ruleguard/dsl` | v0.3.23 | BSD-3-Clause | Development graph |
| `golang.org/x/arch` | v0.27.0 | BSD-3-Clause | Development graph |
| `stretchr/testify` | v1.11.1 | MIT | Development graph |
| `davecgh/go-spew` | v1.1.1 | ISC | Development graph; outside strict code allowlist |
| `pmezard/go-difflib` | v1.0.0 | BSD-3-Clause | Development graph |
| `gopkg.in/yaml.v3` | v3.0.1 | MIT and Apache-2.0 source split | Development graph |

These are manually read root grants with file digests, **not a full per-file,
contributor or original-source provenance audit**. Development ISC is retained
as evidence rather than silently approved. The
[candidate's MIT grant](https://github.com/tphakala/go-flac/blob/v1.1.0/LICENSE)
and [provenance statement](https://github.com/tphakala/go-flac/blob/v1.1.0/THIRD_PARTY.md)
are author-supplied evidence of independent implementation and same-author
vendored MIT SIMD kernels; their assertions were not independently proved.
The candidate's LPC code calls Go `math.Cos`/`math.Log2`, so a root MIT label
does not resolve existing standard-library source-term findings. SIMD's wider
module includes Cephes-labelled f32 algorithms outside the probe's selected
f64/cpu/crc package reach; source and final linked reach still require review
before approving a shipped artifact.

## Independent compatibility matrix

The probe generates deterministic signed little-endian PCM containing minima,
maxima, silence and changing values. `flac 1.4.3` encodes one direction and
decodes the other, so success requires exact PCM equality rather than a codec
self round trip. Compression level is 5 and sample rate is 48 kHz.

- Bit depths: 8, 16, 24 and 32.
- Channels: each count from 1 through 8.
- Per-channel lengths: 1, 15, 16, 31, 4095, 4096, 4097 and 9000.
- 256 fixture shapes, two directions: **480 of 512 comparisons succeeded**.
- All 256 reference-encode/candidate-decode cases succeeded.
- 224 candidate-encode/reference-decode cases succeeded. The 32 failures are
  32-bit output at 4095, 4096, 4097 and 9000 samples for every channel count.
  libFLAC reports lost sync/bad header; FFmpeg 6.1.1 independently rejects the
  first failing mono/4095-sample output with an invalid residual.

The editor currently exports FLAC at **8/16/24 bits**, and accepts input through
32 bits into float32 storage. The 32-bit encoder finding is a broader candidate
support gap, not a regression exercised in the current export path. Decoder
memory and shape validation alone already prevent adoption.

This is a small native matrix at one rate/effort. It does not cover every depth
4–32, compression effort, signal, variable-block stream, IETF corpus, seek,
CPU/SIMD path, WASM independent matrix, one-hour file or output-writer failure.

## Malformed-input and allocation findings

All listed behavior matched under Linux amd64 and Node WASM. The valid fixture
contains 4097 stereo 16-bit frames, yielding 16,388 packed PCM bytes.

| Mutation | Observed result | Adoption implication |
| --- | --- | --- |
| TotalSamples unknown (0), MD5 present or zero | Complete PCM, no error | Expected unknown-count behavior |
| TotalSamples 1, MD5 present or zero | All 4097 frames, no error | Excess actual count is not rejected |
| TotalSamples 4098 or maximum 36-bit value, true nonzero MD5 | Complete PCM, no error | A correct PCM MD5 bypasses declared-count validation |
| Same too-large counts with zero MD5 | Truncated-stream error | Only this count/checksum branch rejects the mismatch |
| Declared mono with stereo audio frames | Complete PCM, no error | `Info()` and packed channel layout disagree |
| Declared 44.1 kHz with 48 kHz audio frames | Complete PCM, no error | Stream/frame sample-rate mismatch is not rejected |
| Declared 24-bit with 16-bit audio frames, zero MD5 | 24,582 bytes, no error | Packing uses declared width while accepting a different frame depth |
| Modified MD5, frame CRC, final-byte truncation, metadata truncation | Error | Controls confirm basic corruption/truncation detection |
| Truncated maximum-length SEEKTABLE after valid STREAMINFO | Error after **16,786,464 bytes allocated** | A 46-byte input causes approximately 16 MiB metadata allocation before validation |

The allocation figure is `runtime.MemStats.TotalAlloc` around construction and
streaming drain after GC. It includes decoder/sink bookkeeping, not retained
editor storage or peak process RSS. The ordinary valid case allocates about
58 KiB. It demonstrates an input-driven allocation, not an unbounded claim:
FLAC's metadata length field is capped at 24 bits. Source inspection of
`internal/meta/meta.go` confirms `readBytes` allocates the entire SEEKTABLE body
before its first read, then `parseSeekTable` can allocate another decoded-point
slice for a complete table. Output byte caps do not protect this constructor.

Per-frame storage grows from parsed frame sizes inside the decoder, with no
editor scratch-accounting hook. Format field maxima constrain these buffers,
but the editor must reserve them before allocation and cannot trust STREAMINFO
to bound a disagreeing actual frame. The packed PCM API hides actual per-frame
rate/depth/channels, preventing the current adapter's direct per-frame checks.
Source inspection of `pcm/decoder.go:finish` explains the count/MD5 split.

Changing some audio properties is permitted by RFC 9639 Appendix C.8. The
property-change findings above identify incompatibility with this fixed-format
packed PCM API and the editor adapter; they do not classify every such stream
as malformed. The remediation rejects unsupported changes explicitly.

## Required next steps

1. Repair malformed-input validation upstream: validate frame rate, channel
   count, bit depth, block bounds and frame/sample sequencing against the
   stream; enforce exact nonzero total count independently of MD5; retain
   sticky failure and truncation/checksum errors. Add native/WASM regressions.
2. Add bounded metadata parsing or an explicit option to skip unused seek
   tables without constructing them, with pre-allocation length/divisibility
   checks and caller-controlled metadata/scratch ceilings. Charge scratch in
   the editor before retaining any decoder buffers. A non-seekable source by
   itself does not bypass current SEEKTABLE allocation.
3. Diagnose the independently rejected 32-bit residual encoding and verify an
   upstream fix against reference decoders. Keep existing export-depth scope
   unless a separate feature change is intentionally validated.
4. Publish a new tagged, audited release after these fixes; rerun this probe,
   full source/provenance review and the replacement plan's corpus, atomic
   imports, bounded writers, one-hour memory/performance, native/WASM/browser
   and binary-budget acceptance before product adoption.

No upstream issue, pull request, contributor message, grant change or new
release was published by this evaluation. A reproducible failing candidate is
useful evidence; it does not close the current FLAC license-policy finding.
