import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

// Production artifacts, including every lazy JS chunk. See docs/web-deployment.md.
const dist = process.argv[2] ?? "apps/editor-web/dist";
const files = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const name = path.join(directory, entry.name);
  return entry.isDirectory() ? files(name) : [name];
});
const all = files(dist);
const wasmFiles = all.filter((name) => /kernel-[a-f0-9]{16}\.wasm$/.test(name));
if (wasmFiles.length !== 1) throw new Error("Expected one content-hashed kernel artifact.");
const measure = (name) => {
  const bytes = readFileSync(name);
  return { name: path.relative(dist, name), raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length };
};
const wasm = measure(wasmFiles[0]);
const js = all.filter((name) => name.endsWith(".js")).map(measure);
const entryName = readFileSync(path.join(dist, "index.html"), "utf8").match(/<script[^>]*type="module"[^>]*src="[^"]*\/([^/"?]+\.js)"/)?.[1];
const entry = js.find((file) => path.basename(file.name) === entryName);
if (!entry) throw new Error("Production module entry not found.");
const limits = { wasmRaw: 12 * 1024 * 1024, wasmGzip: 3 * 1024 * 1024, chunkRaw: 500 * 1024, entryGzip: 160 * 1024, totalJsGzip: 384 * 1024 };
const totalJsGzip = js.reduce((sum, file) => sum + file.gzip, 0);
const report = { wasm, entry, totalJsGzip, largestChunkRaw: Math.max(...js.map((file) => file.raw)), limits };
console.log(JSON.stringify(report, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Build size budgets:\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`);
if (wasm.raw > limits.wasmRaw || wasm.gzip > limits.wasmGzip || entry.gzip > limits.entryGzip || totalJsGzip > limits.totalJsGzip || js.some((file) => file.raw > limits.chunkRaw))
  throw new Error("Production artifacts exceed the JS/WASM size budgets.");
