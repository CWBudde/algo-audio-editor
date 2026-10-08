# Testing strategy

Run everything through `just` (see AGENTS.md for the recipe list).

## Layers

- **Kernel (Go):** table-driven unit tests; reviewed golden vectors, checked in,
  for every process and effect; property tests for the block model; fuzzing for
  every decoder (`FuzzWAVOpen`, `FuzzCodecOpen`, `FuzzDocumentExport` run as a
  bounded smoke in `just ci`). `just test-go-wasm` runs the kernel tests under
  `js/wasm` in Node for bridge and golden-vector parity.
- **Render paths:** benchmarks with tracked allocations; render, transport,
  resampling and meter paths must stay at 0 B/op (`-benchmem`).
- **Frontend:** Vitest for logic (ring buffer, RPC, command registry, coordinate
  mapping) and React Testing Library for complex components. Run one-shot
  (`vitest run`).
- **End-to-end:** Playwright against the production build for browser, Pages
  subpath and Electron (development and packaged Linux). Audio-correctness tests
  compare actual exported PCM with independent expectations rather than
  inspecting UI state only.
- **Timing:** hardware `@timing` gates (`just e2e-timing`) and the browser
  benchmark recipes run in isolation on the target laptop. They are not
  shared-runner CI gates.

## Coverage targets

- ≥ 90 % for `internal/audiobuf` and the processing packages `internal/process`
  and `internal/effects`
- ≥ 80 % for the kernel overall (every package, including `cmd/`)

`just check-coverage` enforces these on the statement profile that
`just test-go-race` writes; `just check`, `just ci` and the CI Go job run it and
fail below a target. The targets live in `scripts/check-coverage.mjs`. Raise
coverage with tests rather than lowering a target.

Protocol parity compares every payload field's kind, optionality and nullability
between Go and TypeScript and checks shared golden files on both sides.
`TestSchemaHashPinsVersion` pins the schema hash to `protocol.Version`: after a
shape change, bump both versions and re-pin from `packages/kernel` with
`go test ./internal/protocol -run '^TestSchemaHashPinsVersion$' -update-schema-hash`.

CI retries failed browser tests once (Pages tests twice). A test that passes only
on retry is reported in the E2E job summary and as a warning annotation; record
it in PLAN Phase 28 rather than relying on the retry.

## Reporting verification

- State which checks actually ran. A local `just ci` pass does not establish
  hosted CI for a commit, installed Windows/macOS behavior, live Pages behavior
  or hardware timing.
- Never relax a timing, underrun or correctness limit to make a gate pass;
  record failures and variance instead.
- Put dated counts, timings and screenshots in `docs/benchmarks/` and link the
  report from `PLAN.md`; keep PLAN.md itself to current state and open work.
