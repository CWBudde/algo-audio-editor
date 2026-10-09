import { expect, test } from "@playwright/test";
import { edit, fixture, info, LEFT, load, RIGHT, select } from "./edit-fixture.ts";
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

test("opening another file over unsaved changes asks first and keeps the document when cancelled", async ({
  page,
}) => {
  await load(page);
  await select(page, 2, 6);
  await edit(page, "Mute", 8);
  await expect(page.getByTestId("history-dirty")).toHaveText("Unsaved changes");
  const before = await info(page);
  const asked = page.waitForEvent("dialog");
  await page.getByTestId("audio-file-input").setInputFiles({
    name: "replacement.wav",
    mimeType: "audio/wav",
    buffer: fixture([LEFT, RIGHT], 44_100),
  });
  const prompt = await asked;
  expect(prompt.type()).toBe("confirm");
  expect(prompt.message()).toContain(`Discard changes to ${before.name}?`);
  await prompt.dismiss();
  await expect(page.getByTestId("history-dirty")).toHaveText("Unsaved changes");
  await expect(page.getByTestId("document-details")).toContainText("48000 Hz");
  expect((await info(page)).documentId).toBe(before.documentId);
});

test("opening another file over unsaved changes replaces the document once discarded", async ({
  page,
}) => {
  await load(page);
  await select(page, 2, 6);
  await edit(page, "Mute", 8);
  await expect(page.getByTestId("history-dirty")).toHaveText("Unsaved changes");
  const asked = page.waitForEvent("dialog");
  await load(page, [LEFT, RIGHT], 44_100);
  expect((await asked).message()).toContain("Discard changes to ");
  await expect(page.getByTestId("history-dirty")).toHaveText("Saved");
});
