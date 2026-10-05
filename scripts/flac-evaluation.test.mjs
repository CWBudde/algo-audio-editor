import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("./flac-evaluation.mjs", import.meta.url));
for (const args of [
  ["--unknown"],
  ["--output"],
  ["--output", "--unknown"],
  ["--output", "report.json", "extra"],
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
