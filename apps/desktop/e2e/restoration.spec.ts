import path from "node:path";
import { expect, test } from "@playwright/test";
import { captureKernelWorker } from "../../editor-web/e2e/kernel-probe.js";
import { spectralClickRepair, stretchInShell } from "../../editor-web/e2e/restoration-fixture.js";
import { closeEditor, launchEditor } from "./launch.js";

test("Electron spectral repair and duration editing use the actual kernel and undo", async () => {
  test.setTimeout(60000);
  const app = await launchEditor({
    args: [path.join(__dirname, ".."), "--autoplay-policy=no-user-gesture-required"],
  });
  try {
    const page = await app.firstWindow();
    await captureKernelWorker(page);
    await page.reload();
    await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
    await spectralClickRepair(page);
    await stretchInShell(page);
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    await closeEditor(app);
  }
});
