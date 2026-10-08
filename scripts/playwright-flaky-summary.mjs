import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// CI retries failed Playwright tests, so a test that fails and then passes keeps
// the job green. Report those `flaky` outcomes in the job summary and as warning
// annotations instead of letting retries hide them; record each one in PLAN
// Phase 28. This reports only and never fails the job.
export function flakyTests(report, source = "") {
  const found = [];
  // Top-level suites are spec files; nested suites are describe blocks.
  const visit = (suite, titles) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        if (test.status !== "flaky") continue;
        const failures = (test.results ?? []).filter((result) => result.status !== "passed" && result.status !== "skipped");
        found.push({
          source,
          file: spec.file ?? suite.file ?? "",
          line: spec.line ?? 0,
          title: [...titles, spec.title].join(" › "),
          project: test.projectName ?? "",
          attempts: (test.results ?? []).length,
          error: firstLine(failures[0]?.error?.message ?? failures[0]?.errors?.[0]?.message ?? ""),
        });
      }
    }
    for (const child of suite.suites ?? []) visit(child, [...titles, child.title]);
  };
  for (const suite of report.suites ?? []) visit(suite, []);
  return found;
}

// Error messages carry ANSI colors and long call logs; the first line names it.
function firstLine(message) {
  return (
    message
      .replace(/\u001b\[[0-9;]*m/g, "")
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? ""
  );
}

const cell = (value) => String(value).replaceAll("|", "\\|");

export function render(flaky, missing = []) {
  const lines = ["### Flaky Playwright tests", ""];
  if (flaky.length === 0) lines.push("No test needed a retry to pass.");
  else {
    lines.push(`${flaky.length} test(s) failed and then passed on retry. Record each in PLAN Phase 28.`, "");
    lines.push("| Report | Test | Location | Attempts | First failure |", "| --- | --- | --- | ---: | --- |");
    for (const test of flaky) {
      const project = test.project ? ` (${cell(test.project)})` : "";
      lines.push(`| ${cell(test.source)} | ${cell(test.title)}${project} | ${cell(test.file)}:${test.line} | ${test.attempts} | ${cell(test.error)} |`);
    }
  }
  for (const report of missing) lines.push("", `Report \`${report}\` was not written; its run did not finish.`);
  return `${lines.join("\n")}\n`;
}

export function annotations(flaky, testDir) {
  return flaky.map((test) => {
    const file = testDir ? path.posix.join(testDir, test.file) : test.file;
    return `::warning file=${file},line=${test.line},title=Flaky Playwright test::${test.title} passed only after ${test.attempts} attempts`;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Usage: playwright-flaky-summary.mjs <test dir for annotations> <report.json>...
  const [testDir, ...reports] = process.argv.slice(2);
  const missing = reports.filter((report) => !existsSync(report));
  const flaky = reports
    .filter((report) => existsSync(report))
    .flatMap((report) => flakyTests(JSON.parse(readFileSync(report, "utf8")), path.basename(report, ".json")));
  const summary = render(flaky, missing);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  else process.stdout.write(summary);
  for (const line of annotations(flaky, testDir)) console.log(line);
}
