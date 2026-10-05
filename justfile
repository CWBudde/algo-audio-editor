set shell := ["bash", "-euo", "pipefail", "-c"]

export GOPRIVATE := "github.com/cwbudde"

kernel := "packages/kernel"
web := "apps/editor-web"
desktop := "apps/desktop"


default:
    @just --list

# ── Setup ────────────────────────────────────────────────────────────────────

# Install workspace dependencies, the Electron binary and git hooks
install:
    bun install
    bun run --cwd {{desktop}} install-electron
    bunx lefthook install

# ── Kernel (Go → WASM) ───────────────────────────────────────────────────────

# Build kernel.wasm and copy the matching wasm_exec.js into the web app
wasm-build:
    node scripts/build-wasm.mjs

# Build the native single-file/batch CLI and stdio MCP server (host OS/architecture).
native-build:
    mkdir -p {{kernel}}/bin
    cd {{kernel}} && go build -trimpath -o bin/ ./cmd/aae ./cmd/aae-mcp

# ── Development ──────────────────────────────────────────────────────────────

# Regenerate checked-in desktop/web icons (requires ImageMagick).
icons:
    node scripts/generate-icons.mjs

# Regenerate the CC0 demo with Go/upstream DSP.
demo:
    cd {{kernel}} && go run ./cmd/demo-build

# Bound all production JS/WASM artifacts after the web build.
check-web-budget:
    node scripts/check-web-budget.mjs

# Start the Vite dev server (rebuilds the kernel first)
dev: wasm-build
    bun run --cwd {{web}} dev

# Production build of the web app into apps/editor-web/dist
build: wasm-build
    bun run --cwd {{web}} build
    just check-web-budget

# Serve the production build locally (COOP/COEP headers included)
preview: build
    bun run --cwd {{web}} preview

# Build the web app and the Electron shell, then launch it
desktop-dev: build desktop-build
    bun run --cwd {{desktop}} start

# Run the Electron shell against the Vite dev server (start `just dev` first)
desktop-hot: desktop-build
    AAE_DEV_URL=http://localhost:5173 bun run --cwd {{desktop}} start

desktop-build:
    bun run --cwd {{desktop}} build

# Build a local installer for the host OS; never publish from this recipe.
desktop-package: build desktop-build
    bun run --cwd {{desktop}} package

# Assemble an unpacked app for packaged-runtime verification.
desktop-package-dir: build desktop-build
    bun run --cwd {{desktop}} package --dir

# ── Tests ────────────────────────────────────────────────────────────────────

test: test-go test-web test-desktop

test-go:
    cd {{kernel}} && go test ./...

test-go-race:
    cd {{kernel}} && go test -race -covermode=atomic -coverprofile=coverage.out ./...

# Verify native golden vectors and immutable storage under the actual WASM build.
test-go-wasm:
    cd {{kernel}} && GOOS=js GOARCH=wasm go test \
        -exec="env -i $(command -v node) --stack-size=8192 $(go env GOROOT)/lib/wasm/wasm_exec_node.js" ./...

# Opt-in published EBU vectors, supplied externally under the EBU usage terms.
test-ebu fixtures:
    fixtures_path='{{fixtures}}'; test -d "$fixtures_path"; case "$fixtures_path" in /*) ;; *) echo "EBU fixture directory must be absolute" >&2; exit 1;; esac; \
    cd {{kernel}} && GOWORK=off AAE_EBU_TEST_SET="$fixtures_path" go test ./internal/engine -run '^TestPublishedEBU' -count=1

test-ebu-wasm fixtures:
    fixtures_path='{{fixtures}}'; test -d "$fixtures_path"; case "$fixtures_path" in /*) ;; *) echo "EBU fixture directory must be absolute" >&2; exit 1;; esac; \
    cd {{kernel}} && GOWORK=off GOOS=js GOARCH=wasm AAE_EBU_TEST_SET="$fixtures_path" go test \
        -exec="env -i \"AAE_EBU_TEST_SET=$fixtures_path\" $(command -v node) --stack-size=8192 $(go env GOROOT)/lib/wasm/wasm_exec_node.js" ./internal/engine -run '^TestPublishedEBU' -count=1

# Exercise malformed container inputs in the native, shared WAV import path.
fuzz-wav duration="10s":
    cd {{kernel}} && go test -run '^$' -fuzz '^FuzzWAVOpen$' -fuzztime='{{duration}}' -parallel=2 ./internal/engine

# Exercise malformed FLAC/AIFF/MP3 inputs through the Go import path.
fuzz-codecs duration="10s":
    cd {{kernel}} && go test -run '^$' -fuzz '^FuzzCodecOpen$' -fuzztime='{{duration}}' -parallel=2 ./internal/engine

# Exercise container export/quantization with malformed options and sample bits.
fuzz-export duration="10s":
    cd {{kernel}} && go test -run '^$' -fuzz '^FuzzDocumentExport$' -fuzztime='{{duration}}' -parallel=2 ./internal/engine

test-web:
    bun run --cwd {{web}} test

# Main-process security and filesystem tests run without launching Electron.
test-desktop:
    bun run --cwd {{desktop}} test

# Browser end-to-end tests against the production build (no hardware timing gates)
e2e: build native-build
    bun run --cwd {{web}} e2e

# Actual headerless Pages subpath and cold service-worker boot.
e2e-pages:
    VITE_BASE=/algo-audio-editor/ VITE_OUT_DIR=dist-pages just build
    AAE_EXPECTED_COMMIT="$(git rev-parse HEAD)" bun run --cwd {{web}} e2e --config playwright.pages.config.ts

# Live site verification without rebuilding or launching a local server.
e2e-pages-live:
    test -n "${PLAYWRIGHT_BASE_URL:-}"
    bun run --cwd {{web}} e2e --config playwright.pages.config.ts

# Opt-in hardware timing gates (`@timing`): run on the target laptop, not on shared CI.
e2e-timing: build
    AAE_TIMING=1 bun run --cwd {{web}} e2e

# Electron end-to-end tests (needs a display, or xvfb-run on CI)
e2e-desktop: build desktop-build
    bun run --cwd {{desktop}} e2e

# Linux packaged-runtime smoke, including ASAR preload and bundled web/WASM.
e2e-desktop-packaged: desktop-package-dir
    AAE_PACKAGED_EXECUTABLE="$(pwd)/{{desktop}}/release/linux-unpacked/algo-audio-editor" bun run --cwd {{desktop}} e2e e2e/packaged.spec.ts

bench:
    cd {{kernel}} && go test -run '^$' -bench . -benchmem ./...

# Run the kernel benchmarks in V8 through Go's WASM runner (Node required).
# A clean runner environment avoids Go WASM's 4 KiB argv/environment limit.
bench-wasm:
    cd {{kernel}} && GOOS=js GOARCH=wasm go test \
        -exec="env -i $(command -v node) --stack-size=8192 $(go env GOROOT)/lib/wasm/wasm_exec_node.js" \
        -run '^$' -bench . -benchtime=1x -benchmem ./internal/audiobuf ./internal/engine ./internal/ops ./internal/history ./internal/process

# Full-size gain/normalization processing and engine transactions; run serially.
bench-process:
    cd {{kernel}} && go test -run '^$' -bench '^Benchmark(Gain|EngineProcess|EngineNormalize)TenMinuteStereo$' \
        -benchtime=1x -benchmem ./internal/process ./internal/engine

# The same ten-minute gain/normalization benchmarks in a clean V8 WASM runner.
bench-process-wasm:
    cd {{kernel}} && GOOS=js GOARCH=wasm go test \
        -exec="env -i $(command -v node) --stack-size=8192 $(go env GOROOT)/lib/wasm/wasm_exec_node.js" \
        -run '^$' -bench '^Benchmark(Gain|EngineProcess|EngineNormalize)TenMinuteStereo$' \
        -benchtime=1x -benchmem ./internal/process ./internal/engine

# Opt-in hardware timing gate: full ten-minute import, including file read and UI.
# Run in isolation on the target laptop; this is not part of shared-runner CI.
bench-import-browser: build
    AAE_IMPORT_BENCHMARK=1 bun run --cwd {{web}} e2e e2e/import-benchmark.spec.ts --workers=1

# Opt-in hardware gate: ten-minute 32-case Phase 3.2 matrix, commit/handoff and painted waveforms.
# Run serially on the target laptop; this is not part of shared-runner CI.
bench-process-browser: build
    AAE_PROCESS_BENCHMARK=1 bun run --cwd {{web}} e2e e2e/process-benchmark.spec.ts --workers=1

# Profile the same full-size import natively; output_dir must be an existing absolute path.
# Keep the test binary/profile outside the worktree, then print CPU hotspots.
bench-import-profile output_dir:
    [[ '{{output_dir}}' == /* && -d '{{output_dir}}' ]]
    cd {{kernel}} && go test -run '^$' -bench '^BenchmarkWAVImportTenMinuteStereo$' \
        -benchtime=3x -benchmem -o '{{output_dir}}/engine.test' \
        -cpuprofile '{{output_dir}}/cpu.pprof' ./internal/engine
    go tool pprof -top '{{output_dir}}/engine.test' '{{output_dir}}/cpu.pprof'

# Real one-hour 48 kHz stereo FLAC acceptance; run serially (~1.5 GiB retained).
test-flac-hour:
    cd {{kernel}} && AAE_LARGE_FILE_ACCEPTANCE=1 go test ./internal/engine -run '^TestFLACImportOneHour$' -count=1 -v -timeout=15m

test-flac-hour-wasm:
    cd {{kernel}} && GOOS=js GOARCH=wasm AAE_LARGE_FILE_ACCEPTANCE=1 go test \
        -exec="env -i AAE_LARGE_FILE_ACCEPTANCE=1 $(command -v node) --stack-size=8192 $(go env GOROOT)/lib/wasm/wasm_exec_node.js" \
        ./internal/engine -run '^TestFLACImportOneHour$' -count=1 -v -timeout=15m

# Generate a compact real codec fixture outside the repository (output must not exist).
flac-hour-fixture output:
    [[ '{{output}}' == /* ]]
    cd {{kernel}} && go run ./cmd/flac-fixture '{{output}}'

# Full production browser import-to-painted-waveform acceptance, without a timing threshold.
test-flac-hour-browser fixture: build
    [[ '{{fixture}}' == /* && -f '{{fixture}}' ]]
    AAE_HOUR_FLAC_FIXTURE='{{fixture}}' bun run --cwd {{web}} e2e e2e/flac-hour.spec.ts --workers=1

# One-hour JSON analysis round-trip comparison (shared repeated source, no codec import).
bench-analysis-hour:
    cd {{kernel}} && AAE_ANALYSIS_HOUR_BENCHMARK=1 go test ./internal/engine -run '^$' \
        -bench '^BenchmarkAnalysisOneHour$' -benchtime=1x -benchmem -timeout=30m

bench-analysis-hour-wasm:
    cd {{kernel}} && GOOS=js GOARCH=wasm AAE_ANALYSIS_HOUR_BENCHMARK=1 go test \
        -exec="env -i AAE_ANALYSIS_HOUR_BENCHMARK=1 $(command -v node) --stack-size=8192 $(go env GOROOT)/lib/wasm/wasm_exec_node.js" \
        ./internal/engine -run '^$' -bench '^BenchmarkAnalysisOneHour$' -benchtime=1x -benchmem -timeout=30m

# ── Lint & format ────────────────────────────────────────────────────────────

lint: lint-go lint-web

lint-go:
    cd {{kernel}} && golangci-lint run ./...
    cd {{kernel}} && GOOS=js GOARCH=wasm golangci-lint run ./...

lint-web:
    bunx biome lint apps packages/protocol
    bun run --cwd {{web}} typecheck
    bun run --cwd {{desktop}} typecheck

fmt:
    treefmt

check-formatted:
    treefmt --fail-on-change

check-tidy:
    cd {{kernel}} && go mod tidy -diff

# ── Family hygiene (see AGENTS.md) ───────────────────────────────────────────

# Audit pinned Go/npm sources and regenerate the inventory and shipped notices.
licenses:
    node scripts/generate-licenses.mjs

# Opt-in candidate probe: temporary module, network downloads and local libFLAC.
# Exit success means the report completed; its failures block candidate adoption.
evaluate-flac:
    node scripts/flac-evaluation.mjs

# Evaluate the retained local upstream patch; never used by product builds.
evaluate-flac-remediated:
    node scripts/flac-evaluation.mjs --remediated

# Check reviewed inventory/input hashes and notices without registry downloads.
check-licenses:
    node --test scripts/license-policy.test.mjs scripts/licenses-go.test.mjs scripts/licenses-npm.test.mjs scripts/licenses-electron.test.mjs
    node scripts/generate-licenses.mjs --check

# First-release gate: no unresolved runtime evidence or bundled-license findings.
check-license-policy:
    node scripts/generate-licenses.mjs --check --strict

# Are all github.com/cwbudde/* deps at their latest tags?
check-deps:
    cd {{kernel}} && ../../scripts/release-guard.sh deps

# How much work is sitting on main past the latest tag?
check-unreleased:
    ./scripts/release-guard.sh unreleased

# ── Aggregate ────────────────────────────────────────────────────────────────

# Fast local gate: formatting, lint, unit tests and the production build.
check: check-formatted check-licenses lint test-go-race test-web test-desktop check-tidy build

# Electron e2e needs a display; headless, run `xvfb-run --auto-servernum just ci`.
# Everything CI runs (.github/workflows/ci.yml and the test-*.yml it calls), in one recipe.
ci: check-formatted check-licenses lint test-go-race test-go-wasm fuzz-wav fuzz-codecs fuzz-export test-web test-desktop check-tidy e2e e2e-pages e2e-desktop e2e-desktop-packaged

clean:
    rm -rf {{kernel}}/bin
    rm -rf {{web}}/dist {{web}}/dist-pages {{desktop}}/dist {{web}}/public/kernel.wasm {{web}}/public/wasm_exec.js
    rm -f {{kernel}}/coverage.out
