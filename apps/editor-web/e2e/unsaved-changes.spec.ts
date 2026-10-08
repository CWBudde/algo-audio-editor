import { expect, test } from "@playwright/test";
import { edit, load, select } from "./edit-fixture.ts";
import { captureKernelWorker } from "./kernel-probe.ts";

test.beforeEach(async ({ page }) => {
  await captureKernelWorker(page);
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
});

test("closing the tab asks before discarding unsaved changes", async ({ page }) => {
  await load(page);
  await select(page, 2, 6);
  await edit(page, "Mute", 8);
  await expect(page.getByTestId("history-dirty")).toHaveText("Unsaved changes");
  const dialog = page.waitForEvent("dialog");
  await page.close({ runBeforeUnload: true });
  const prompt = await dialog;
  expect(prompt.type()).toBe("beforeunload");
  await prompt.dismiss();
  expect(page.isClosed()).toBe(false);
  await expect(page.getByTestId("history-dirty")).toHaveText("Unsaved changes");
});

test("a clean document closes without a prompt", async ({ page }) => {
  await load(page);
  await expect(page.getByTestId("history-dirty")).toHaveText("Saved");
  page.on("dialog", (dialog) => {
    throw new Error(`unexpected ${dialog.type()} dialog`);
  });
  const closed = page.waitForEvent("close");
  await page.close({ runBeforeUnload: true });
  await closed;
});
