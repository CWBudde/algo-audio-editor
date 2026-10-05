import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  baseModule,
  baseSum,
  readRemediationAssets,
  verifyRemediationSource,
} from "./flac-remediation.mjs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("./flac-evaluation.mjs", import.meta.url));
for (const args of [
  ["--unknown"],
  ["--output"],
  ["--output", "--unknown"],
  ["--output", "report.json", "extra"],
  ["--remediated", "--remediated"],
  ["--remediated", "--output"],
  ["--output", "a.json", "--output", "b.json"],
  ["--remediated", "extra"],
]) {
  test(`rejects malformed arguments without invoking external tools: ${args.join(" ")}`, () => {
    const result = spawnSync(process.execPath, [script, ...args], {
      env: { PATH: "/nonexistent" },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^Usage:/);
    assert.equal(result.stdout, "");
  });
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "flac-remediation-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const patch = "verified patch fixture\n";
  const source = "package pcm\n";
  const manifest = {
    baseModule,
    baseSum,
    baseCommit: "41022d6b879fd3cc7703facec93e0af94f1b49c5",
    patchSha256: sha256(patch),
    sourceFiles: [{ path: "pcm/decoder.go", sha256: sha256(source) }],
  };
  const writeManifest = () =>
    writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
  writeManifest();
  writeFileSync(join(directory, "robustness.patch"), patch);
  mkdirSync(join(directory, "pcm"));
  writeFileSync(join(directory, "pcm/decoder.go"), source);
  return { directory, manifest, writeManifest };
}

test("verifies immutable patch and exact post-application source offline", (t) => {
  const { directory } = fixture(t);
  const { manifest, patch } = readRemediationAssets(directory);
  assert.equal(patch.toString(), "verified patch fixture\n");
  assert.equal(verifyRemediationSource(directory, manifest), 1);
});

test("rejects a tampered patch before an external command could run", (t) => {
  const { directory } = fixture(t);
  writeFileSync(join(directory, "robustness.patch"), "tampered\n");
  assert.throws(() => readRemediationAssets(directory), /patch hash mismatch/);
});

test("rejects a tampered patched source", (t) => {
  const { directory, manifest } = fixture(t);
  writeFileSync(join(directory, "pcm/decoder.go"), "package altered\n");
  assert.throws(() => verifyRemediationSource(directory, manifest), /source hash mismatch/);
});

for (const [field, value] of [
  ["baseModule", "github.com/tphakala/go-flac@unverified"],
  ["baseSum", "h1:unverified"],
  ["baseCommit", "unverified"],
  ["patchSha256", "not-a-sha256"],
  ["sourceFiles", []],
  ["sourceFiles", [{ path: "pcm/decoder.go", sha256: "not-a-sha256" }]],
  ["sourceFiles", [{ path: "../../outside.go", sha256: "a".repeat(64) }]],
  ["sourceFiles", [{ path: "/pcm/decoder.go", sha256: "a".repeat(64) }]],
  ["sourceFiles", [{ path: "pcm\\decoder.go", sha256: "a".repeat(64) }]],
  ["sourceFiles", [{ path: "LICENSE", sha256: "a".repeat(64) }]],
  [
    "sourceFiles",
    [
      { path: "pcm/decoder.go", sha256: "a".repeat(64) },
      { path: "pcm/decoder.go", sha256: "b".repeat(64) },
    ],
  ],
]) {
  test(`rejects invalid remediation manifest ${field}: ${JSON.stringify(value)}`, (t) => {
    const { directory, manifest, writeManifest } = fixture(t);
    manifest[field] = value;
    writeManifest();
    assert.throws(() => readRemediationAssets(directory));
  });
}
