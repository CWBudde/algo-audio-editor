import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, chromium, expect, test } from "@playwright/test";
import { verifyPackagedFuses } from "../src/harden-package.js";

test("hardened packaged app loads bundled resources with sandboxed preload", async () => {
  test.skip(
    !process.env.AAE_PACKAGED_EXECUTABLE,
    "Build an unpacked app with just desktop-package-dir first.",
  );
  test.setTimeout(60_000);
  const executable = process.env.AAE_PACKAGED_EXECUTABLE as string;
  await verifyPackagedFuses(executable);
  const directory = await mkdtemp(path.join(tmpdir(), "aae-packaged-"));
  const configHome = path.join(directory, "config");
  const forbiddenProfile = path.join(directory, "forbidden-profile");
  const injectionMarker = path.join(directory, "node-options-injected");
  const injectionScript = path.join(directory, "injection.cjs");
  await mkdir(configHome);
  await writeFile(
    injectionScript,
    `require("node:fs").writeFileSync(${JSON.stringify(injectionMarker)}, "injected");`,
  );
  // Playwright's Electron launcher needs a main-process Node inspector. The real
  // release disables that fuse, so connect only to Chromium's renderer debugger.
  const child = spawn(executable, ["--no-sandbox", "--remote-debugging-port=0", "--inspect=0"], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
      AAE_USER_DATA: forbiddenProfile,
      AAE_DEV_URL: "http://127.0.0.1:9",
      ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: `--require=${injectionScript}`,
    },
  });
  let diagnostics = "";
  let browser: Browser | undefined;
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Packaged renderer debugger did not start:\n${diagnostics}`));
      }, 30_000);
      const cleanup = () => {
        clearTimeout(timeout);
        child.off("error", failed);
        child.off("exit", exited);
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const exited = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        reject(new Error(`Packaged app exited (${code ?? signal}):\n${diagnostics}`));
      };
      child.once("error", failed);
      child.once("exit", exited);
      child.stderr.on("data", (data: Buffer) => {
        diagnostics = (diagnostics + data.toString()).slice(-128_000);
        const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(diagnostics);
        if (match) {
          cleanup();
          resolve(match[1]);
        }
      });
    });
    browser = await chromium.connectOverCDP(endpoint);
    await expect
      .poll(() => browser?.contexts().flatMap((context) => context.pages()).length ?? 0)
      .toBeGreaterThan(0);
    const page = browser.contexts().flatMap((context) => context.pages())[0];
    await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
    expect(page.url()).toBe("app://editor/index.html");
    await expect(page.getByRole("menubar")).toHaveCount(0);
    expect(
      await page.evaluate(() => ({
        isolated: globalThis.crossOriginIsolated,
        node: typeof (globalThis as { require?: unknown }).require,
        native: typeof window.aaeDesktop?.openFile,
      })),
    ).toEqual({ isolated: true, node: "undefined", native: "function" });
    // A real profile was created under the OS config root; the packaged-only
    // environment override and arbitrary Node startup code were both ignored.
    expect((await readdir(configHome)).length).toBeGreaterThan(0);
    await expect(access(forbiddenProfile)).rejects.toThrow();
    await expect(access(injectionMarker)).rejects.toThrow();
    expect(diagnostics).not.toContain("Debugger listening on");
  } finally {
    await browser?.close().catch(() => {});
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          deadline = setTimeout(resolve, 6_000);
        }),
      ]);
      clearTimeout(force);
      clearTimeout(deadline);
    }
    await rm(directory, { recursive: true, force: true });
  }
});
