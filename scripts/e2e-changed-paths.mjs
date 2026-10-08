import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Pull requests run the slow browser/Electron suites only when they can change
// what those suites exercise: editor and desktop sources, the specs and their
// fixtures, the Playwright configs, and the e2e workflow itself. Three editor
// redesign commits once left five specs stale because E2E never ran on them.
const prefixes = [
  "apps/editor-web/src/",
  "apps/editor-web/e2e/",
  "apps/desktop/src/",
  "apps/desktop/e2e/",
];
const files = new Set([
  "apps/editor-web/playwright.config.ts",
  "apps/editor-web/playwright.pages.config.ts",
  "apps/desktop/playwright.config.ts",
  ".github/workflows/test-e2e.yml",
]);

export function needsE2E(paths) {
  return paths.some((file) => files.has(file) || prefixes.some((prefix) => file.startsWith(prefix)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Usage: <changed paths, one per line> | e2e-changed-paths.mjs
  const paths = readFileSync(0, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const output = `run=${needsE2E(paths)}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
}
