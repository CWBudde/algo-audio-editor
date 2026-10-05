import path from "node:path";
import { expect, test } from "@playwright/test";
import { load, samples, select } from "../../editor-web/e2e/edit-fixture.js";
import { sourceState } from "../../editor-web/e2e/export-fixture.js";
import { captureKernelWorker } from "../../editor-web/e2e/kernel-probe.js";
import { closeEditor, launchEditor } from "./launch.js";

test("Electron waveform owns Home/End and accessible edge keys without changing audio or saved history", async () => {
  const app = await launchEditor({ args: [path.join(__dirname, "..")] });
  try {
    const page = await app.firstWindow();
    await captureKernelWorker(page);
    await page.reload();
    await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
    const audio = [Array.from({ length: 48_000 }, (_, frame) => ((frame % 256) - 128) / 256)];
    await load(page, audio);
    await expect(page.getByTestId("waveform-channel-0")).toHaveAttribute("data-rendered", "true");
    const before = await sourceState(page);
    const surface = page.getByRole("group", { name: "Channel 1 waveform editor", exact: true });
    await surface.focus();
    await page.keyboard.press("End");
    await expect
      .poll(async () => (await sourceState(page)).selection)
      .toEqual({
        documentId: before.document.documentId,
        start: 48_000,
        end: 48_000,
        channelMask: 1,
      });
    await expect(page.getByTestId("play-position")).toHaveAttribute("data-frame", "48000");
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+ArrowRight");
    await expect
      .poll(async () => (await sourceState(page)).selection)
      .toEqual({
        documentId: before.document.documentId,
        start: 0,
        end: 1,
        channelMask: 1,
      });
    await expect(page.getByTestId("play-position")).toHaveAttribute("data-frame", "1");
    await select(page, 1_000, 2_000);
    const edge = page.getByRole("slider", { name: "Selection end edge channel 1", exact: true });
    await edge.focus();
    await expect(edge).toBeFocused();
    await page.keyboard.press("Shift+ArrowRight");
    await expect(edge).toHaveAttribute("aria-valuenow", "2010");
    await page.keyboard.press("PageUp");
    await expect(edge).toHaveAttribute("aria-valuenow", "48000");
    await page.keyboard.press("Home");
    await expect(edge).toHaveAttribute("aria-valuenow", "1000");
    await expect
      .poll(async () => (await sourceState(page)).selection)
      .toEqual({
        documentId: before.document.documentId,
        start: 1_000,
        end: 1_000,
        channelMask: 1,
      });
    await expect(edge).toBeFocused();
    await expect(page.getByTestId("play-position")).toHaveAttribute("data-frame", "1000");
    const after = await sourceState(page);
    expect(after.document).toEqual(before.document);
    expect(after.history).toEqual(before.history);
    expect(after.timeline).toEqual(before.timeline);
    expect(await samples(page)).toEqual(audio);
    await expect(page.getByTestId("history-dirty")).toHaveText("Saved");
  } finally {
    await closeEditor(app);
  }
});
