import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Native paths and argument arrays work on Windows as well as POSIX shells.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, "apps/editor-web/public");
const kernel = path.join(root, "packages/kernel");
const buildinfo = "github.com/cwbudde/algo-audio-editor/packages/kernel/internal/buildinfo";
let version = "dev";
try {
  version = execFileSync("git", ["describe", "--tags", "--always", "--dirty"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {}
mkdirSync(destination, { recursive: true });
execFileSync("go", [
  "build",
  "-trimpath",
  `-ldflags=-s -w -X ${buildinfo}.Version=${version} -X ${buildinfo}.BuildTime=${new Date().toISOString()}`,
  "-o",
  path.join(destination, "kernel.wasm"),
  "./cmd/kernel",
], {
  cwd: kernel,
  env: { ...process.env, GOOS: "js", GOARCH: "wasm" },
  stdio: "inherit",
});
// Run the pinned, portable Binaryen CLI with the existing Go feature set.
// Preserve trapping/IEEE semantics; no fast-math or traps-never-happen flags.
execFileSync(process.execPath, [
  path.join(root, "node_modules/binaryen/bin/wasm-opt"),
  path.join(destination, "kernel.wasm"),
  "-Oz", "--enable-bulk-memory", "--enable-nontrapping-float-to-int", "--enable-sign-ext",
  "-o", path.join(destination, "kernel.wasm"),
], { stdio: "inherit" });
const goroot = execFileSync("go", ["env", "GOROOT"], { encoding: "utf8" }).trim();
const runtime = ["lib", "misc"]
  .map(directory => path.join(goroot, directory, "wasm/wasm_exec.js"))
  .find(existsSync);
if (!runtime) throw new Error(`wasm_exec.js not found under ${goroot}`);
// Go's runtime can be read-only (e.g. from a module/toolchain cache). Replace
// the generated file rather than trying to overwrite its inherited mode.
rmSync(path.join(destination, "wasm_exec.js"), { force: true });
copyFileSync(runtime, path.join(destination, "wasm_exec.js"));
