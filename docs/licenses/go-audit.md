# Go dependency audit (2026-10-05)

The collector in `scripts/licenses-go.mjs` reads the exact versions selected by
`packages/kernel/go.mod`, including the full selected module graph. The audit
found **27 external modules plus Go 1.26.8**: 20 runtime entries and eight
development entries. This is source evidence and a conservative dependency
inventory, not release approval. The roadmap's literal MIT/BSD/Apache policy is
not satisfied by every runtime entry.

Runtime classification uses the union of `go list -deps` for the native `aae`
and `aae-mcp` commands on Linux, macOS and Windows, each on amd64 and arm64,
and `cmd/kernel` on js/wasm. The inventory does not claim optional BoringCrypto,
cgo or custom build tags were analyzed. `CGO_ENABLED=0` is an explicit pure-Go
audit target; the native
build recipe does not force that value, so default-cgo build provenance remains
an additional limit. Module graph entries outside this union are marked development;
that includes test/example dependencies and graph-only dependencies. Go's
linker may remove some inventoried code, so runtime classification does not
prove every source file reaches every binary.

Each exact module is downloaded through Go's module machinery, its `h1` checksum
is retained, and `go mod verify` checks the cache. Collection uses temporary
copies of `go.mod` and `go.sum`; it does not rewrite repository dependency
inputs. The pinned `toolchain` directive selects the runtime version. Replaced
modules are rejected rather than silently attributing another source's license.

| Module | Version | Scope | Declared/code license |
| --- | --- | --- | --- |
| cloud.google.com/go/compute/metadata | v0.3.0 | development | Apache-2.0 |
| github.com/cwbudde/aiff | v0.1.0 | runtime | Apache-2.0 |
| github.com/cwbudde/algo-approx | v0.2.0 | development | MIT declaration; full text missing |
| github.com/cwbudde/algo-dsp | v0.10.2 | runtime | MIT |
| github.com/cwbudde/algo-fft | v0.8.0 | runtime | MIT |
| github.com/cwbudde/algo-vecmath | v0.1.3 | runtime | unknown; LICENSE missing |
| github.com/cwbudde/flac | v0.1.0 | runtime | Unlicense; embedded BSD references unresolved |
| github.com/cwbudde/wav | v0.1.4 | runtime | Apache-2.0 |
| github.com/go-audio/aiff | v1.0.0 | development | Apache-2.0 |
| github.com/go-audio/audio | v1.0.0 | runtime | Apache-2.0 |
| github.com/go-audio/riff | v1.0.0 | runtime | Apache-2.0 |
| github.com/golang-jwt/jwt/v5 | v5.3.1 | development | MIT |
| github.com/google/go-cmp | v0.7.0 | development | BSD-3-Clause |
| github.com/google/jsonschema-go | v0.4.3 | runtime | MIT |
| github.com/hajimehoshi/go-mp3 | v0.3.4 | runtime | Apache-2.0 |
| github.com/hajimehoshi/oto/v2 | v2.3.1 | development | Apache-2.0 |
| github.com/icza/bitio | v1.1.0 | runtime | Apache-2.0 |
| github.com/icza/mighty | v0.0.0-20180919140131-cfd07d671de6 | development | Apache-2.0 |
| github.com/modelcontextprotocol/go-sdk | v1.8.0 | runtime | Apache-2.0 AND MIT |
| github.com/segmentio/asm | v1.1.3 | runtime | MIT |
| github.com/segmentio/encoding | v0.5.4 | runtime | MIT |
| github.com/yosida95/uritemplate/v3 | v3.0.2 | runtime | BSD-3-Clause |
| golang.org/x/oauth2 | v0.35.0 | runtime | BSD-3-Clause |
| golang.org/x/sync | v0.20.0 | runtime | BSD-3-Clause |
| golang.org/x/sys | v0.41.0 | runtime | BSD-3-Clause |
| golang.org/x/time | v0.15.0 | runtime | BSD-3-Clause |
| golang.org/x/tools | v0.42.0 | development | BSD-3-Clause |
| Go runtime and standard library | go1.26.8 | runtime | BSD-1-Clause AND BSD-3-Clause AND MIT AND SunPro AND LicenseRef-Cephes |

`algo-approx`'s README states MIT but the tagged module supplies no full license
text. `algo-vecmath`'s README links to a LICENSE file absent from the tagged
module. Neither finding grants new rights or permits substituting the editor's
own MIT license. Resolve the missing evidence upstream and consume a tagged
release before clearing these findings.

FLAC's root LICENSE is Unlicense, outside the stated bundled-code allowlist.
`internal/hashutil/crc8/crc8.go` and `crc16/crc16.go` also carry Go Authors
copyright headers referring to BSD terms in LICENSE, while the module supplies
only Unlicense there. Both source notices are preserved. Resolving the missing
embedded BSD text and deciding whether to replace FLAC or change the literal
policy remain open; the collector does not relicense this dependency.

The MCP SDK's full LICENSE describes a transition: new/consenting code uses
Apache-2.0, while contributions without relicensing consent retain MIT. The
inventory therefore uses `Apache-2.0 AND MIT`, preserving the entire supplied
file. Its separate CC-BY-4.0 clause covers documentation, not the imported Go
code. Documentation is not copied into application notices except for that
clause's presence within the unchanged legal file.

Go's root BSD license and PATENTS are included along with relevant vendored
licenses/patents, source copyright/permission blocks and `lib/wasm/wasm_exec.js`'s
own header. Embedded notices include fiat-crypto's BSD-1-Clause permission,
Inferno/Lucent/Vita Nuova's MIT memmove permission, SunPro math permissions and
Cephes/Stephen L. Moshier's copyright/free-use wording. The latter two are not
silently treated as MIT/BSD/Apache. `LicenseRef-Cephes` describes the supplied
wording rather than claiming an SPDX license identifier.

Root legal files and legal files covering selected source directories are
preserved, plus unique legal comment blocks in selected Go/assembly/C/JS
sources. Development entries retain their broader legal-file/source evidence.
Unimported example audio and its EFF OAL notice from go-mp3 are excluded from
runtime notices; this application does not ship that example. The scanner is
not a Go parser or a complete provenance investigation: algorithm comments,
unlabeled assets and upstream files without recognizable notices still require
human review. Regenerating reads current exact source evidence; the lightweight
check only verifies dependency-input freshness and declared identities.

Validation: four Node regression tests cover streamed Go JSON including nested
objects/escaped braces, unsupported/missing and mixed license classification,
embedded notices after package declarations, and the Go-free identity guard's
pinned toolchain/replacement rejection. Real collection covered all seven
target configurations and passed module-cache verification; before/after
`go.sum` bytes matched. `just check-tidy` passed. This audit did not run or
install native Windows/macOS builds, change upstream licenses, or publish a
release.
