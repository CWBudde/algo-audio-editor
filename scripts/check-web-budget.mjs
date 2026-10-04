import { appendFileSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

// Baseline and headroom are documented in docs/web-deployment.md.
const bytes = readFileSync("apps/editor-web/public/kernel.wasm");
const gzip = gzipSync(bytes, { level: 9 }).length;
const limit = 4 * 1024 * 1024;
const report = `Kernel: ${bytes.length} bytes raw; ${gzip} bytes gzip; budget ${limit} bytes gzip.`;
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
if (gzip > limit) throw new Error("Kernel exceeds the 4 MiB gzip download budget.");
