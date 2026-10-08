import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { annotations, flakyTests, render } from "./playwright-flaky-summary.mjs";

const script = fileURLToPath(new URL("./playwright-flaky-summary.mjs", import.meta.url));

// Shape of Playwright 1.x JSON reporter output (trimmed from an actual run with
// `retries: 1`): file suites, nested describe suites, specs with per-project tests.
const result = (status, message) => ({ status, ...(message ? { error: { message } } : {}) });
const report = {
  suites: [
    {
      title: "smoke.spec.ts",
      file: "smoke.spec.ts",
      specs: [{ title: "stable", file: "smoke.spec.ts", line: 4, tests: [{ projectName: "chromium", status: "expected", results: [result("passed")] }] }],
      suites: [
        {
          title: "group",
          file: "smoke.spec.ts",
          specs: [
            {
              title: "passes on retry",
              file: "smoke.spec.ts",
              line: 3,
              tests: [
                {
                  projectName: "chromium",
                  status: "flaky",
                  results: [result("failed", "\u001b[2mError:\u001b[22m Timed out | 5000ms\n\nCall log:\n  - waiting"), result("passed")],
                },
              ],
            },
            { title: "broken", file: "smoke.spec.ts", line: 9, tests: [{ projectName: "chromium", status: "unexpected", results: [result("failed", "x"), result("failed", "x")] }] },
          ],
        },
      ],
    },
  ],
};

test("only tests that passed after a failed attempt are reported", () => {
  assert.deepEqual(flakyTests(report, "browser"), [
    {
      source: "browser",
      file: "smoke.spec.ts",
      line: 3,
      title: "group › passes on retry",
      project: "chromium",
      attempts: 2,
      error: "Error: Timed out | 5000ms",
    },
  ]);
  assert.deepEqual(flakyTests({ suites: [] }), []);
});

test("the summary escapes table cells and names unfinished reports", () => {
  const summary = render(flakyTests(report, "browser"), ["pages.json"]);
  assert.match(summary, /1 test\(s\) failed and then passed on retry/);
  assert.match(summary, /\| browser \| group › passes on retry \(chromium\) \| smoke\.spec\.ts:3 \| 2 \| Error: Timed out \\\| 5000ms \|/);
  assert.match(summary, /Report `pages\.json` was not written/);
  assert.match(render([]), /No test needed a retry to pass\./);
});

test("annotations point at the spec file under the test directory", () => {
  assert.deepEqual(annotations(flakyTests(report), "apps/editor-web/e2e"), [
    "::warning file=apps/editor-web/e2e/smoke.spec.ts,line=3,title=Flaky Playwright test::group › passes on retry passed only after 2 attempts",
  ]);
});

test("the command appends to the step summary, annotates and never fails the job", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aae-flaky-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const json = path.join(directory, "browser.json");
  const summary = path.join(directory, "summary.md");
  await writeFile(json, JSON.stringify(report));
  const run = spawnSync(process.execPath, [script, "apps/editor-web/e2e", json, path.join(directory, "pages.json")], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^::warning file=apps\/editor-web\/e2e\/smoke\.spec\.ts,line=3,/m);
  const written = await readFile(summary, "utf8");
  assert.match(written, /### Flaky Playwright tests/);
  assert.match(written, /\| browser \| group › passes on retry/);
  assert.match(written, /Report `.*pages\.json` was not written/);
});
