import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { closeEditor } from "./launch.js";

test("packaged app loads its bundled web resources and sandboxed preload", async () => {
  test.skip(
    !process.env.AAE_PACKAGED_EXECUTABLE,
    "Build an unpacked app with just desktop-package-dir first.",
  );
  const directory = await mkdtemp(path.join(tmpdir(), "aae-packaged-"));
  const app = await electron.launch({
    executablePath: process.env.AAE_PACKAGED_EXECUTABLE,
    args: ["--no-sandbox"],
    env: { ...process.env, AAE_USER_DATA: directory },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    expect(page.url()).toBe("app://editor/index.html");
    await expect(page.getByRole("menubar")).toHaveCount(0);
    expect(
      await page.evaluate(() => ({
        isolated: globalThis.crossOriginIsolated,
        node: typeof (globalThis as { require?: unknown }).require,
        native: typeof window.aaeDesktop?.openFile,
      })),
    ).toEqual({ isolated: true, node: "undefined", native: "function" });
  } finally {
    await closeEditor(app);
    await rm(directory, { recursive: true, force: true });
  }
});
