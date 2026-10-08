#!/bin/sh
# Run a Go developer tool pinned by a `tool` directive in tools/go.mod, from any
# directory. `go tool -modfile` needs a go.mod in the working directory, so ask
# the tools module for the cached binary instead and run it here, keeping the
# caller's relative paths intact.
#
# Usage: scripts/go-tool.sh <gofumpt|gci|golangci-lint> [args...]
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
tool=$1
shift
# Build the tool for the host; GOOS/GOARCH (e.g. js/wasm lint) apply to the
# tool's own run, not to its binary.
binary=$(env -u GOOS -u GOARCH go -C "$root/tools" tool -n "$tool")
exec "$binary" "$@"
