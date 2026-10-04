// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../../scripts/check-web-budget.mjs", import.meta.url));
const directories: string[] = [];
function artifact() {
  const dir = mkdtempSync(path.join(tmpdir(), "aae-budget-"));
  directories.push(dir);
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(
    path.join(dir, "index.html"),
    '<script type="module" src="/assets/index.js"></script>',
  );
  writeFileSync(path.join(dir, "assets/index.js"), 'console.log("editor");');
  writeFileSync(path.join(dir, "kernel-0123456789abcdef.wasm"), new Uint8Array([0, 97, 115, 109]));
  return dir;
}
function check(dir: string) {
  return execFileSync(process.execPath, [script, dir], {
    encoding: "utf8",
    stdio: "pipe",
    env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
  });
}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
it("counts deferred chunks and rejects their raw size even when they gzip very small", () => {
  const dir = artifact();
  expect(JSON.parse(check(dir)).entry.name).toBe("assets/index.js");
  writeFileSync(path.join(dir, "assets/effects-lazy.js"), "/".repeat(500 * 1024 + 1));
  expect(() => check(dir)).toThrow(/JS\/WASM size budgets/);
});
it("fails closed on missing hashed WASM and enforces raw WASM independently of gzip", () => {
  const dir = artifact();
  const wasm = path.join(dir, "kernel-0123456789abcdef.wasm");
  rmSync(wasm);
  expect(() => check(dir)).toThrow(/content-hashed kernel artifact/);
  writeFileSync(wasm, new Uint8Array(12 * 1024 * 1024 + 1));
  expect(() => check(dir)).toThrow(/JS\/WASM size budgets/);
});
