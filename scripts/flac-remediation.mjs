import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const baseModule = "github.com/tphakala/go-flac@v1.1.0";
export const baseSum = "h1:dyVNPFW+MVLzPvw1n3dEvBHPtKUMbQ5PHWvW/pxQMv0=";
const baseCommit = "41022d6b879fd3cc7703facec93e0af94f1b49c5";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const hashPattern = /^[a-f0-9]{64}$/;

// Validate all local inputs before downloading or executing any external tool.
// This fixed-format evidence bundle is specific to the verified v1.1.0 archive.
export function readRemediationAssets(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.baseModule, baseModule, "Unexpected remediation base module");
  assert.equal(manifest.baseSum, baseSum, "Unexpected remediation base checksum");
  assert.equal(manifest.baseCommit, baseCommit, "Unexpected remediation base commit");
  assert.match(manifest.patchSha256 ?? "", hashPattern, "Invalid remediation patch hash");
  assert.ok(
    Array.isArray(manifest.sourceFiles) && manifest.sourceFiles.length > 0,
    "Missing remediation source hashes",
  );
  const paths = new Set();
  for (const entry of manifest.sourceFiles) {
    assert.ok(
      entry &&
        typeof entry.path === "string" &&
        (entry.path === "limits.go" ||
          /^(internal|pcm)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.go$/.test(entry.path)),
      "Invalid remediation source path",
    );
    assert.ok(!entry.path.split("/").includes(".."), "Invalid remediation source path");
    assert.ok(!paths.has(entry.path), "Duplicate remediation source path");
    paths.add(entry.path);
    assert.match(entry.sha256 ?? "", hashPattern, "Invalid remediation source hash");
  }
  const patch = readFileSync(join(directory, "robustness.patch"));
  assert.equal(sha256(patch), manifest.patchSha256, "Remediation patch hash mismatch");
  return { manifest, patch };
}

// Hash the exact patched files, including regression tests, before compiling.
export function verifyRemediationSource(directory, manifest) {
  for (const entry of manifest.sourceFiles) {
    const file = join(directory, entry.path);
    assert.ok(lstatSync(file).isFile(), `Remediation source is not a regular file: ${entry.path}`);
    assert.equal(
      sha256(readFileSync(file)),
      entry.sha256,
      `Remediation source hash mismatch: ${entry.path}`,
    );
  }
  return manifest.sourceFiles.length;
}
