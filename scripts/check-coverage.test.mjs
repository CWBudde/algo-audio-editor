import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { findings, parseProfile, render, summarize } from "./check-coverage.mjs";

const script = fileURLToPath(new URL("./check-coverage.mjs", import.meta.url));
const module = "example.com/kernel";
const goals = { total: 80, packages: { "internal/process": 90 } };

function profile(lines) {
  return `mode: atomic\n${lines.join("\n")}\n`;
}

test("statements aggregate per package and repeated blocks count once if any hit", () => {
  const blocks = parseProfile(
    profile([
      `${module}/internal/process/a.go:1.1,2.2 3 0`,
      `${module}/internal/process/a.go:1.1,2.2 3 4`,
      `${module}/internal/process/a.go:3.1,4.2 1 0`,
      `${module}/cmd/aae/main.go:1.1,2.2 6 0`,
    ]),
  );
  const summary = summarize(blocks);
  assert.deepEqual(summary.total, { statements: 10, covered: 3 });
  assert.deepEqual(summary.packages.get(`${module}/internal/process`), { statements: 4, covered: 3 });
});

test("targets fail below the threshold and pass at it", () => {
  const below = findings(summarize(parseProfile(profile([`${module}/internal/process/a.go:1.1,2.2 89 1`, `${module}/internal/process/a.go:3.1,4.2 11 0`]))), goals);
  assert.deepEqual(
    below.map((row) => [row.name, row.ok]),
    [
      ["kernel total", true],
      ["internal/process", false],
    ],
  );
  const at = findings(summarize(parseProfile(profile([`${module}/internal/process/a.go:1.1,2.2 9 1`, `${module}/internal/process/a.go:3.1,4.2 1 0`]))), goals);
  assert.ok(at.every((row) => row.ok));
  assert.match(render(below), /\| internal\/process \| 89\.0% ❌ \| ≥90% \|/);
});

test("a missing target package and malformed profiles fail closed", () => {
  const other = summarize(parseProfile(profile([`${module}/internal/ops/a.go:1.1,2.2 1 1`])));
  assert.throws(() => findings(other, goals), /no single package for internal\/process/);
  assert.throws(() => parseProfile("not a profile"), /missing mode line/);
  assert.throws(() => parseProfile("mode: set\n"), /Empty coverage profile/);
  assert.throws(() => parseProfile(profile(["garbage"])), /Malformed coverage line/);
});

test("the command exits nonzero below target and appends the table to the step summary", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aae-coverage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const coverage = path.join(directory, "coverage.out");
  const summary = path.join(directory, "summary.md");
  const lines = ["audiobuf", "process", "effects"].map((name) => `${module}/internal/${name}/a.go:1.1,2.2 1 1`);
  await writeFile(coverage, profile([...lines, `${module}/internal/process/b.go:1.1,2.2 1 0`]));
  const run = spawnSync(process.execPath, [script, coverage], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /internal\/process/);
  assert.match(await readFile(summary, "utf8"), /### Kernel coverage[\s\S]*internal\/process \| 50\.0% ❌/);
});
