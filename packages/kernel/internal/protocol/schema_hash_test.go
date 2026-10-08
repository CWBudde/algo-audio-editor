//go:build !js

// Running the schema extractor needs a subprocess, which js/wasm lacks.

package protocol_test

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"os/exec"
	"strconv"
	"testing"

	"github.com/cwbudde/algo-audio-editor/packages/kernel/internal/protocol"
)

var updateSchemaHash = flag.Bool("update-schema-hash", false,
	"re-pin testdata/schema-hash.json to the current protocol.Version and schema hash")

const schemaHashPath = "testdata/schema-hash.json"

// schemaPin ties the ABI version to the hash of every method name and payload
// field shape (name, kind, optional, nullable) that scripts/protocol-schema.go
// extracts. The TypeScript parity test checks the same pin.
type schemaPin struct {
	Version int    `json:"version"`
	Hash    string `json:"hash"`
}

func TestSchemaHashPinsVersion(t *testing.T) {
	// The extractor is a standalone stdlib file; the test runs in this package's directory.
	cmd := exec.Command("go", "run", "../../../../scripts/protocol-schema.go", ".")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	output, err := cmd.Output()
	if err != nil {
		t.Fatalf("protocol-schema: %v\n%s", err, stderr.Bytes())
	}
	var schema struct {
		Version string `json:"version"`
		Hash    string `json:"hash"`
	}
	if err := json.Unmarshal(output, &schema); err != nil {
		t.Fatal(err)
	}
	if schema.Version != strconv.Itoa(protocol.Version) || schema.Hash == "" {
		t.Fatalf("protocol-schema reported version %q hash %q, want version %d", schema.Version, schema.Hash, protocol.Version)
	}
	current := schemaPin{Version: protocol.Version, Hash: schema.Hash}
	if *updateSchemaHash {
		encoded, err := json.MarshalIndent(current, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(schemaHashPath, append(encoded, '\n'), 0o600); err != nil {
			t.Fatal(err)
		}
		return
	}
	data, err := os.ReadFile(schemaHashPath)
	if err != nil {
		t.Fatal(err)
	}
	var pinned schemaPin
	if err := json.Unmarshal(data, &pinned); err != nil {
		t.Fatalf("%s: %v", schemaHashPath, err)
	}
	const repin = "go test ./internal/protocol -run '^TestSchemaHashPinsVersion$' -update-schema-hash"
	switch {
	case pinned == current:
	case pinned.Version == current.Version:
		t.Fatalf("protocol schema changed without an ABI version bump (pinned hash %s, current %s).\n"+
			"A changed method or payload shape (field name, kind, optionality or nullability) needs:\n"+
			"  1. protocol.Version and PROTOCOL_VERSION bumped to %d, and both protocol sides updated in the same commit;\n"+
			"  2. the pin rewritten from packages/kernel with: %s\n"+
			"Only a change that keeps every existing payload's wire shape (a Go type rename, a new method or payload\n"+
			"reviewed as purely additive) may skip step 1; then run step 2 and say so in the commit body.",
			pinned.Hash, current.Hash, current.Version+1, repin)
	default:
		t.Fatalf("protocol.Version is %d but %s pins version %d (hash %s, current %s).\n"+
			"After bumping protocol.Version and PROTOCOL_VERSION, re-pin from packages/kernel with: %s",
			current.Version, schemaHashPath, pinned.Version, pinned.Hash, current.Hash, repin)
	}
}
