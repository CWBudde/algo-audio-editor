/// <reference lib="dom" />

import type { HistoryListResult, SelectionResult } from "@aae/protocol";
import { expect, type Page, test } from "@playwright/test";
import { info, LEFT, load, RIGHT, samples, select } from "./edit-fixture.ts";
import { captureKernelWorker } from "./kernel-probe.ts";
import { playbackWAV } from "./playback-fixture.ts";
import { capturePlayback } from "./playback-probe.ts";
import { revealControl } from "./ui-disclosures.ts";

async function history(page: Page) {
  const document = await info(page);
  return page.evaluate(
    async (documentId) =>
      (await window.__aaeTest?.request("history.list", { documentId })) as HistoryListResult,
    document.documentId,
  );
}
async function amplify(page: Page, gainDb: string) {
  await page.getByRole("menuitem", { name: "Process", exact: true }).click();
  await page.locator('[role="menuitem"][data-command-id="process.amplify"]').click();
  const dialog = page.getByRole("dialog", { name: "Amplify", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Gain (dB)").fill(gainDb);
  return dialog;
}
test.beforeEach(async ({ page }) => {
  await captureKernelWorker(page);
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
});

test("gain processing changes only selected frames/channels and is one exact undoable edit", async ({
  page,
}) => {
  await load(page);
  await select(page, 2, 6);
  await (await revealControl(page.getByRole("button", { name: "Right", exact: true }))).click();
  const before = await info(page);
  const saved = await history(page);
  const dialog = await amplify(page, "-6.020599913279624");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(async () => (await info(page)).documentId).not.toBe(before.documentId);
  const changed = [
    LEFT,
    RIGHT.map((sample, index) => (index >= 2 && index < 6 ? Math.fround(sample * 0.5) : sample)),
  ];
  expect(await samples(page)).toEqual(changed);
  expect((await history(page)).entries).toHaveLength(saved.entries.length + 1);
  expect((await history(page)).dirty).toBe(true);
  await page.getByTestId("document-details").click();
  await page.keyboard.press("Control+z");
  await expect.poll(async () => await samples(page)).toEqual([LEFT, RIGHT]);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(async () => await samples(page)).toEqual(changed);
});

test("preview uses the real worklet, keeps the saved document untouched, and Cancel restores ordinary playback", async ({
  page,
}) => {
  await capturePlayback(page);
  await page.reload();
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
  await page
    .getByTestId("audio-file-input")
    .setInputFiles({ name: "preview.wav", mimeType: "audio/wav", buffer: playbackWAV(144000) });
  await expect(page.getByTestId("document-name")).toHaveText("preview.wav");
  const before = await info(page);
  const saved = await history(page);
  const dialog = await amplify(page, "-6.020599913279624");
  await dialog.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(dialog.getByTestId("process-status")).toContainText("Previewing");
  const levels = () =>
    page.evaluate(() =>
      window.__aaePlaybackProbe?.analysers.map((analyser) => {
        const values = new Float32Array(256);
        analyser.getFloatTimeDomainData(values);
        return Array.from(values).every((value) => value === values[0]) ? values[0] : null;
      }),
    );
  await expect.poll(levels).toEqual([0.25, -0.125]);
  expect(await info(page)).toEqual(before);
  expect(await history(page)).toEqual(saved);
  await expect(page.getByTestId("history-dirty")).toHaveText("Saved");
  await expect(page.getByTestId("underruns")).toHaveText("0");
  await dialog.getByRole("button", { name: "Stop preview" }).click();
  await expect(dialog.getByTestId("process-status")).toHaveText("Processed copy ready");
  await dialog.getByRole("button", { name: "Preview", exact: true }).click();
  await expect.poll(levels).toEqual([0.25, -0.125]);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).not.toBeVisible();
  expect(await history(page)).toEqual(saved);
  const range = await page.evaluate(
    async (documentId) =>
      (await window.__aaeTest?.request("selection.get", { documentId })) as SelectionResult,
    before.documentId,
  );
  expect(range.start).toBe(0);
  expect(range.end).toBe(0);
  await page.getByTestId("play").click();
  await expect.poll(levels).toEqual([0.5, -0.25]);
  await page.getByTestId("stop").click();
});

test("full-file gain from a cursor warns before clipping and zero gain is a true clean no-op", async ({
  page,
}) => {
  await load(page);
  const before = await info(page);
  const saved = await history(page);
  let dialog = await amplify(page, "0");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(await info(page)).toEqual(before);
  expect(await history(page)).toEqual(saved);
  dialog = await amplify(page, "6.020599913279624");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("exceeds full scale");
  expect(await info(page)).toEqual(before);
  expect(await history(page)).toEqual(saved);
  await dialog.getByRole("button", { name: "Apply anyway" }).click();
  await expect(dialog).not.toBeVisible();
  expect(await samples(page)).toEqual([LEFT.map((n) => n * 2), RIGHT.map((n) => n * 2)]);
});

test("Cancel overtakes a real sliced job without committing or losing its source document", async ({
  page,
}) => {
  await page
    .getByTestId("audio-file-input")
    .setInputFiles({ name: "cancel.wav", mimeType: "audio/wav", buffer: playbackWAV(48_000 * 60) });
  await expect(page.getByTestId("document-name")).toHaveText("cancel.wav");
  const before = await info(page);
  const saved = await history(page);
  const dialog = await amplify(page, "-3");
  // Cancel from the first unsolicited progress event: no sleeps or artificially
  // slowed DSP, and the remaining chunks still yield to the real cancellation.
  await page.evaluate(() => {
    const worker = window.__aaeTest?.workers[0];
    if (!worker) throw new Error("worker missing");
    const cancelOnProgress = (event: MessageEvent) => {
      if (event.data.kind !== "process.progress") return;
      worker.removeEventListener("message", cancelOnProgress);
      const button = Array.from(
        document.querySelectorAll<HTMLButtonElement>("dialog[open] button"),
      ).find((item) => item.textContent === "Cancel");
      button?.click();
    };
    worker.addEventListener("message", cancelOnProgress);
  });
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(await info(page)).toEqual(before);
  expect(await history(page)).toEqual(saved);
  await expect(page.getByTestId("history-dirty")).toHaveText("Saved");
});
