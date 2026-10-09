import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
// The editor kernel carries build metadata; the lazily loaded speech worker
// (go-pocket-tts) is a separate program that never touches documents.
const programs = [
  { name: "kernel.wasm", pkg: "./cmd/kernel", ldflags: `-s -w -X ${buildinfo}.Version=${version} -X ${buildinfo}.BuildTime=${new Date().toISOString()}` },
  { name: "speech.wasm", pkg: "./cmd/speech", ldflags: "-s -w" },
];
for (const program of programs) {
  const output = path.join(destination, program.name);
  execFileSync("go", ["build", "-trimpath", `-ldflags=${program.ldflags}`, "-o", output, program.pkg], {
    cwd: kernel,
    env: { ...process.env, GOOS: "js", GOARCH: "wasm" },
    stdio: "inherit",
  });
  // Run the pinned, portable Binaryen CLI with the existing Go feature set.
  // Preserve trapping/IEEE semantics; no fast-math or traps-never-happen flags.
  execFileSync(process.execPath, [
    path.join(root, "node_modules/binaryen/bin/wasm-opt"),
    output,
    "-Oz", "--enable-bulk-memory", "--enable-nontrapping-float-to-int", "--enable-sign-ext",
    "-o", output,
  ], { stdio: "inherit" });
}
// The pinned speech model catalog, served with the build: Electron's main
// process downloads only files listed in it.
const catalog = execFileSync("go", ["run", "./cmd/aae", "speech", "catalog"], {
  cwd: kernel,
  env: { ...process.env, GOOS: "", GOARCH: "" },
  maxBuffer: 16 << 20,
});
writeFileSync(path.join(destination, "speech-catalog.json"), catalog);
const goroot = execFileSync("go", ["env", "GOROOT"], { encoding: "utf8" }).trim();
const runtime = ["lib", "misc"]
  .map(directory => path.join(goroot, directory, "wasm/wasm_exec.js"))
  .find(existsSync);
if (!runtime) throw new Error(`wasm_exec.js not found under ${goroot}`);
// Go's runtime can be read-only (e.g. from a module/toolchain cache). Replace
// the generated file rather than trying to overwrite its inherited mode.
rmSync(path.join(destination, "wasm_exec.js"), { force: true });
copyFileSync(runtime, path.join(destination, "wasm_exec.js"));
