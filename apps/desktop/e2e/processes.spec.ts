import path from "node:path";
import { _electron as electron, expect, type Page, test } from "@playwright/test";
import type { HistoryListResult } from "../../../packages/protocol/src/index.js";
import { info, LEFT, load, RIGHT, samples, select } from "../../editor-web/e2e/edit-fixture.js";
import { captureKernelWorker } from "../../editor-web/e2e/kernel-probe.js";

async function history(page: Page) {
  const document = await info(page);
  return page.evaluate(
    async (documentId) =>
      (await window.__aaeTest?.request("history.list", { documentId })) as HistoryListResult,
    document.documentId,
  );
}

async function process(page: Page, command: string) {
  await page.getByRole("menuitem", { name: "Process", exact: true }).click();
  await page.locator(`[role="menuitem"][data-command-id="process.${command}"]`).click();
  return page.locator("dialog[open]");
}

test("Phase 3.2 processors preserve exact samples, history and isolated extraction windows in Electron", async () => {
  test.setTimeout(60_000);
  const app = await electron.launch({
    args: [path.join(__dirname, ".."), "--autoplay-policy=no-user-gesture-required"],
  });
  try {
    await captureKernelWorker(app.context());
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.reload();
    await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
    await load(page);
    await select(page, 2, 6);
    const source = await history(page);
    let dialog = await process(page, "reverse");
    await dialog.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(dialog.getByTestId("process-status")).toContainText("Previewing");
    expect(await history(page)).toEqual(source);
    await dialog.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(await samples(page)).toEqual([
      [0.125, 0.25, 0.75, 0.625, 0.5, 0.375, 0.875, 1],
      [-1, -0.875, -0.375, -0.5, -0.625, -0.75, -0.25, -0.125],
    ]);
    expect((await history(page)).entries).toHaveLength(source.entries.length + 1);
    await page.getByTestId("document-details").click();
    await page.keyboard.press("Control+z");
    await expect.poll(async () => samples(page)).toEqual([LEFT, RIGHT]);

    dialog = await process(page, "stereo-to-mono");
    await dialog.getByLabel("Mono source").selectOption("right");
    await dialog.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(dialog.getByTestId("process-status")).toContainText("Previewing");
    expect((await info(page)).channels).toBe(2);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect((await info(page)).channels).toBe(2);
    expect(await samples(page)).toEqual([LEFT, RIGHT]);
    await select(page, 0, 0);
    dialog = await process(page, "resample");
    await dialog.getByLabel("Sample rate (Hz)").fill("24000");
    await dialog.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(await info(page)).toMatchObject({ sampleRate: 24000, channels: 2, frames: 4 });
    await page.getByTestId("document-details").click();
    await page.keyboard.press("Control+z");
    await expect.poll(async () => samples(page)).toEqual([LEFT, RIGHT]);
    expect((await info(page)).sampleRate).toBe(48000);

    await select(page, 2, 6);
    dialog = await process(page, "generate");
    await dialog.getByLabel("Generator", { exact: true }).selectOption("silence");
    await dialog.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(await samples(page)).toEqual([
      [0.125, 0.25, 0, 0, 0, 0, 0.875, 1],
      [-1, -0.875, 0, 0, 0, 0, -0.25, -0.125],
    ]);
    await page.getByTestId("document-details").click();
    await page.keyboard.press("Control+z");
    await expect.poll(async () => samples(page)).toEqual([LEFT, RIGHT]);

    const beforeExtract = await history(page);
    dialog = await process(page, "extract-channel");
    await dialog.getByLabel("Channel", { exact: true }).selectOption("1");
    const opened = app.waitForEvent("window");
    await dialog.getByRole("button", { name: "Open extracted channel" }).click();
    const child = await opened;
    child.on("pageerror", (error) => errors.push(error.message));
    await expect(child.locator("[data-kernel-state]")).toHaveAttribute(
      "data-kernel-state",
      "ready",
    );
    await expect(dialog).not.toBeVisible();
    expect(child.url()).toBe("app://editor/index.html");
    expect(await child.evaluate(() => crossOriginIsolated)).toBe(true);
    expect(await samples(child)).toEqual([RIGHT.slice(2, 6)]);
    expect((await history(child)).dirty).toBe(true);
    expect(await history(page)).toEqual(beforeExtract);
    expect(await samples(page)).toEqual([LEFT, RIGHT]);
    await child.close();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
