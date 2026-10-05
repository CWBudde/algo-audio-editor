import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  compactWasmInspection,
  diagnosticEnvironment,
  parseArguments,
  pinnedToolchain,
  snapshotKernel,
  verifiedOptimizedNames,
} from "./go-math-reach.mjs";

test("argument guards reject ambiguous or unknown output requests", () => {
  assert.deepEqual(parseArguments([]), {});
  assert.deepEqual(parseArguments(["--output", "report.json"]), { output: "report.json" });
  for (const args of [
    ["--output"],
    ["--output", ""],
    ["--output", "--bad"],
    ["--unknown"],
    ["--output", "one", "--output", "two"],
    ["one"],
  ])
    assert.throws(() => parseArguments(args), /Usage/);
});

test("diagnostics require exact release toolchain and exclude local replacements", () => {
  assert.equal(pinnedToolchain("module example\n\ntoolchain go1.26.8\n"), "go1.26.8");
  for (const text of [
    "go 1.26",
    "toolchain go1.26",
    "toolchain go1.26.8+auto",
    "toolchain go1.26.8\nreplace example => ../example",
    "toolchain go1.26.8\nreplace (\nexample => ../example\n)",
  ])
    assert.throws(() => pinnedToolchain(text));
});

test("saved and inherited build overrides cannot alter baseline architecture flags", () => {
  const original = {
    PATH: "/safe",
    GOMODCACHE: "/cache",
    GOROOT: "/wrong",
    GOGCCFLAGS: "-unsafe",
    GOOS: "wrong",
    GOARCH: "wrong",
    GOENV: "/saved",
    GOFLAGS: "-tags=unsafe",
    GOEXPERIMENT: "unsafe",
    GOAMD64: "v4",
    GOARM64: "v9.5",
    GOTOOLCHAIN: "wrong",
    GOWORK: "/wrong",
    CGO_ENABLED: "1",
  };
  const env = diagnosticEnvironment(original, "go1.26.8", "/temporary");
  assert.equal(env.GOENV, "off");
  assert.equal(env.GOFLAGS, "");
  assert.equal(env.GOEXPERIMENT, "");
  assert.equal(env.GOAMD64, "v1");
  assert.equal(env.GOARM64, "v8.0");
  assert.equal(env.CGO_ENABLED, "0");
  assert.equal(env.GOTOOLCHAIN, "go1.26.8");
  assert.equal(env.GOWORK, "off");
  assert.equal(env.GOTMPDIR, "/temporary");
  assert.equal(env.PATH, "/safe");
  assert.equal(env.GOMODCACHE, "/cache");
  for (const key of ["GOOS", "GOARCH", "GOROOT", "GOGCCFLAGS"]) assert.equal(key in env, false);
  assert.equal(original.GOAMD64, "v4");
});

test("source snapshot hashes private module inputs, embeds and untracked files without binary outputs", () => {
  const temporary = mkdtempSync(join(tmpdir(), "aae-math-snapshot-test-"));
  try {
    const source = join(temporary, "source"),
      destination = join(temporary, "snapshot");
    mkdirSync(join(source, "internal"), { recursive: true });
    mkdirSync(join(source, "bin"));
    writeFileSync(join(source, "go.mod"), "module example\n");
    writeFileSync(join(source, "go.sum"), "pinned sums\n");
    writeFileSync(join(source, "internal", "untracked.go"), "package internal\n");
    writeFileSync(join(source, "internal", "embed.bin"), Buffer.from([0, 255]));
    writeFileSync(join(source, "bin", "aae"), "ignored");
    writeFileSync(join(source, "coverage.out"), "ignored");
    const inventory = snapshotKernel(source, destination);
    assert.deepEqual(
      inventory.files.map((file) => file.file),
      ["go.mod", "go.sum", "internal/embed.bin", "internal/untracked.go"],
    );
    assert.equal(snapshotKernel(destination).sha256, inventory.sha256);
    writeFileSync(join(destination, "go.sum"), "changed copy");
    assert.equal(readFileSync(join(source, "go.sum"), "utf8"), "pinned sums\n");
    assert.notEqual(snapshotKernel(destination).sha256, inventory.sha256);
    writeFileSync(join(source, "internal", "untracked.go"), "changed source");
    assert.notEqual(snapshotKernel(source).sha256, inventory.sha256);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("snapshot rejects source symlinks rather than importing unrecorded external input", (context) => {
  const temporary = mkdtempSync(join(tmpdir(), "aae-math-symlink-test-"));
  try {
    const source = join(temporary, "source");
    mkdirSync(source);
    const external = join(temporary, "external.go");
    writeFileSync(external, "package external\n");
    try {
      symlinkSync(external, join(source, "escape.go"));
    } catch (error) {
      if (error.code === "EPERM") {
        context.skip("Host does not permit source symlink creation");
        return;
      }
      throw error;
    }
    assert.throws(
      () => snapshotKernel(source, join(temporary, "output")),
      /symlink is unsupported/,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("WASM report keeps math names and marks sanitized mapping collisions explicitly", () => {
  const inspection = {
    functionNames: [
      { index: 1, name: "runtime.foo" },
      { index: 2, name: "math.sin" },
      { index: 3, name: "math_cmplx.Sqrt" },
      { index: 4, name: "math.generated" },
    ],
    nonCustomSha256: "fingerprint",
  };
  const reach = {
    retainedMathSymbols: [
      { symbol: "math.sin", mapping: "selected-source-body", sources: ["source"] },
      { symbol: "math/cmplx.Sqrt", mapping: "selected-source-body", sources: ["complex"] },
      { symbol: "math_cmplx.Sqrt", mapping: "unmapped", sources: [] },
    ],
  };
  const result = compactWasmInspection(inspection, reach);
  assert.equal(result.functionNameCount, 4);
  assert.deepEqual(
    result.functionNames.map(({ name }) => name),
    ["math.sin", "math_cmplx.Sqrt", "math.generated"],
  );
  assert.equal(result.functionNames[0].linkerMatches[0].symbol, "math.sin");
  assert.equal(result.functionNames[1].linkerMatches.length, 2);
  assert.deepEqual(result.functionNames[2].linkerMatches, []);
  assert.equal(inspection.functionNames.length, 4);
});

test("optimized companion names are withheld when actual final body bytes differ", () => {
  const named = {
    nonCustomSha256: "named",
    bytes: 123,
    customSections: [],
    functionNames: [{ index: 1, name: "math.sin" }],
  };
  const reach = {
    retainedMathSymbols: [{ symbol: "math.sin", mapping: "selected-source-body", sources: [] }],
  };
  const mismatch = verifiedOptimizedNames({ nonCustomSha256: "actual" }, named, reach);
  assert.equal(mismatch.nonCustomSectionsMatch, false);
  assert.equal(mismatch.mappingAccepted, false);
  assert.equal("functionNames" in mismatch.inspection, false);
  assert.equal(mismatch.inspection.functionNameCount, 1);
  const match = verifiedOptimizedNames({ nonCustomSha256: "named" }, named, reach);
  assert.equal(match.mappingAccepted, true);
  assert.equal(match.inspection.functionNames[0].linkerMatches[0].symbol, "math.sin");
});
