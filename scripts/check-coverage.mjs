import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Coverage targets from docs/testing.md, checked against the profile written by
// `just test-go-race`. Package keys are import-path suffixes of the kernel module.
export const targets = {
  total: 80,
  packages: { "internal/audiobuf": 90, "internal/process": 90, "internal/effects": 90 },
};

// Go writes one "file:start.col,end.col statements count" line per block. A
// block can repeat when several test binaries cover it; any hit covers it.
export function parseProfile(text) {
  if (!text.startsWith("mode: ")) throw new Error("Invalid coverage profile: missing mode line");
  const blocks = new Map();
  for (const line of text.split("\n").slice(1)) {
    if (!line.trim()) continue;
    const match = /^(.+):(\d+\.\d+,\d+\.\d+) (\d+) (\d+)$/.exec(line);
    if (!match) throw new Error(`Malformed coverage line: ${line}`);
    const [, file, span, statements, count] = match;
    const key = `${file}:${span}`;
    const covered = Number(count) > 0 || Boolean(blocks.get(key)?.covered);
    blocks.set(key, { file, statements: Number(statements), covered });
  }
  if (blocks.size === 0) throw new Error("Empty coverage profile");
  return [...blocks.values()];
}

export function summarize(blocks) {
  const packages = new Map();
  const total = { statements: 0, covered: 0 };
  for (const block of blocks) {
    const name = path.posix.dirname(block.file);
    const entry = packages.get(name) ?? { statements: 0, covered: 0 };
    for (const sum of [entry, total]) {
      sum.statements += block.statements;
      if (block.covered) sum.covered += block.statements;
    }
    packages.set(name, entry);
  }
  return { total, packages };
}

const percent = ({ statements, covered }) => (statements === 0 ? 100 : (100 * covered) / statements);

export function findings(summary, goals = targets) {
  const rows = [{ name: "kernel total", actual: percent(summary.total), target: goals.total }];
  for (const [suffix, target] of Object.entries(goals.packages)) {
    const matches = [...summary.packages].filter(([name]) => name === suffix || name.endsWith(`/${suffix}`));
    if (matches.length !== 1) throw new Error(`Coverage profile has no single package for ${suffix}`);
    rows.push({ name: suffix, actual: percent(matches[0][1]), target });
  }
  return rows.map((row) => ({ ...row, ok: row.actual >= row.target }));
}

export function render(rows) {
  const lines = ["| Package | Coverage | Target |", "| --- | ---: | ---: |"];
  for (const row of rows) lines.push(`| ${row.name} | ${row.actual.toFixed(1)}% ${row.ok ? "✅" : "❌"} | ≥${row.target}% |`);
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const profile = process.argv[2] ?? "packages/kernel/coverage.out";
  const rows = findings(summarize(parseProfile(readFileSync(profile, "utf8"))));
  const table = render(rows);
  console.log(table);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Kernel coverage\n\n${table}`);
  const failed = rows.filter((row) => !row.ok);
  if (failed.length > 0) {
    console.error(`Coverage below the docs/testing.md targets: ${failed.map((row) => row.name).join(", ")}`);
    process.exit(1);
  }
}
