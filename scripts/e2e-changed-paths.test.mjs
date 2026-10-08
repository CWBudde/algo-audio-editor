import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { needsE2E } from "./e2e-changed-paths.mjs";

const script = fileURLToPath(new URL("./e2e-changed-paths.mjs", import.meta.url));

test("editor and desktop sources, specs, configs and the e2e workflow need E2E", () => {
  for (const file of [
    "apps/editor-web/src/components/waveform-view.tsx",
    "apps/editor-web/e2e/analysis.spec.ts",
    "apps/desktop/src/main.ts",
    "apps/desktop/e2e/launch.ts",
    "apps/editor-web/playwright.config.ts",
    "apps/editor-web/playwright.pages.config.ts",
    "apps/desktop/playwright.config.ts",
    ".github/workflows/test-e2e.yml",
  ])
    assert.equal(needsE2E(["README.md", file]), true, file);
});

test("kernel, docs, scripts and lookalike paths do not need E2E", () => {
  assert.equal(
    needsE2E([
      "packages/kernel/internal/engine/binary_document.go",
      "PLAN.md",
      "docs/testing.md",
      "scripts/check-coverage.mjs",
      ".github/workflows/ci.yml",
      "apps/editor-web/package.json",
      "apps/editor-web/srcfoo/x.ts",
      "apps/desktop/e2e-notes.md",
    ]),
    false,
  );
  assert.equal(needsE2E([]), false);
});

test("CLI reads paths from stdin and appends run=<bool> to GITHUB_OUTPUT", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "e2e-paths-"));
  try {
    const output = path.join(directory, "output");
    const run = (input) =>
      spawnSync(process.execPath, [script], { input, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output } });
    const hit = run("PLAN.md\napps/desktop/src/main.ts\n");
    assert.equal(hit.status, 0, hit.stderr);
    assert.equal(hit.stdout, "run=true\n");
    const miss = run("PLAN.md\n\n");
    assert.equal(miss.status, 0, miss.stderr);
    assert.equal(miss.stdout, "run=false\n");
    assert.equal(await readFile(output, "utf8"), "run=true\nrun=false\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
