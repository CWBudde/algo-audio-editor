# Go math reach diagnostics

License policy compliance (Phase 27) needs evidence of retained code before replacing math implementations.
`just evaluate-go-math-reach` cross-builds the native CLI and MCP server on Linux,
macOS and Windows (amd64 and arm64), plus the js/wasm kernel. It works in temporary
directories with the pinned kernel toolchain and `CGO_ENABLED=0`, and leaves
product builds and dependency inputs unchanged. The runner is validated on
Linux amd64 with Node 24, git, Go 1.26.8 and the frozen workspace installation;
downloads may populate the Go cache. Cross-compilation does not establish
installed platform acceptance or default-cgo reach.

Save a report outside the working tree:

```sh
just --command node scripts/go-math-reach.mjs --output /tmp/go-math-reach.json
just test-go-math-reach
```

The diagnostic records source, toolchain, command and artifact identities. It
checks selected math files against actual `go list` output, verifies modules
before and after building, and rejects changes to its inputs or kernel snapshot.
Dependency resolution precedes strict linker-log parsing, so cold-cache download
messages cannot become fabricated retention edges. The offline tests run through
`just check-licenses`; the expensive cross-build is opt-in. A completed report is
evidence collection, not permission to clear a license finding. The dependency
inventory, bundled notices and strict release gate remain independent of this
diagnostic.

## Reading the evidence

The pinned [Go linker](https://github.com/golang/go/blob/go1.26.8/src/cmd/link/internal/ld/deadcode.go)
emits `parent -> symbol` when it first marks a symbol reachable. That parent
explains one retention path. These edges are neither a complete call graph nor
a list of every caller. Compiler inlining, architecture-specific implementations,
generated wrappers and data references also matter; a missing function name does
not prove that its source code is absent from an artifact.

The mapping uses AST declarations and assembly `TEXT` bodies from the exact
selected `math` and `math/cmplx` sources, retaining their hashes, line numbers
and notice classifications. File-level notice evidence is conservative. A
wrapper in a file with inherited terms is not, by itself, proof that the entire
generic implementation from that file survives. Conversely, retained generic
bodies such as [expm1](https://github.com/golang/go/blob/go1.26.8/src/math/expm1.go)
and [sin](https://github.com/golang/go/blob/go1.26.8/src/math/sin.go) provide
positive evidence requiring follow-up under the confirmed policy.

The WASM inspection uses the same pinned Binaryen optimization flags as
`build-wasm.mjs`. The raw stripped build must match its named companion after
removing custom sections. For optimized output, names are accepted only if that
same identity check passes. The retained run passes raw identity but fails
optimized identity: the report withholds every optimized companion name and
records an explicit attribution gap. The actual final artifact still has section
and artifact hashes and host WebAssembly validation. All four raw/optimized
artifacts are validated without executing product functions.

The 39 named math functions on the verified raw artifact provide evidence before
optimization. They are not assigned to the differing optimized artifact. Names
that disappear during optimization may have been inlined or merged; they are
not treated as evidence of license exclusion. Final optimized symbol/source
attribution and installed browser execution remain open.

## Replacement work remains open

[Retained validation and JSON](../benchmarks/go-math-reach-2026-10-06.md)
record all 13 builds, positive math paths, raw identity and the optimized gap.

Use positive mapped bodies and their retention paths to scope original permitted
implementations upstream. Specify numerical contracts before replacing DSP calls:
range reduction, extrema, signed zero, subnormals, NaN/infinity and precision
must be covered, alongside allocation and performance regressions. Approximate
`Fast*` functions are not established substitutes for standard-library math.

Rebuild the reach map after each tagged upstream change. Transitive standard
library callers may retain the same bodies after direct DSP calls change. Any
remaining required bodies would need a reproducible, maintained permitted
toolchain replacement; no such compatible replacement is established here.
All original [Go replacement requirements](go-replacements.md#go-math-positive-linked-evidence-then-scoped-replacements)
and the [strict policy findings](README.md#unresolved-evidence-and-policy) remain.
