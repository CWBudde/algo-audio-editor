/// <reference lib="dom" />

import type { HistoryListResult } from "@aae/protocol";
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

async function normalize(
  page: Page,
  mode: "normalize-peak" | "normalize-loudness" = "normalize-peak",
  target?: string,
) {
  await page.getByRole("menuitem", { name: "Process", exact: true }).click();
  await page.locator('[role="menuitem"][data-command-id="process.normalize"]').click();
  const dialog = page.getByRole("dialog", { name: "Normalize", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Normalization mode").selectOption(mode);
  if (target !== undefined)
    await dialog
      .getByLabel(mode === "normalize-peak" ? "Target peak (dBFS)" : "Target loudness (LUFS)")
      .fill(target);
  return dialog;
}

function tone(frames = 48000, db = -33) {
  // Test fixture only: published EBU3341 stereo1kHz calibration tone.
  const amplitude = 10 ** (db / 20);
  const period = Array.from({ length: 48 }, (_, frame) =>
    Math.fround(amplitude * Math.sin((2 * Math.PI * frame) / 48)),
  );
  const values = Array.from({ length: frames }, (_, frame) => period[frame % 48]);
  return [values, values];
}

test.beforeEach(async ({ page }) => {
  await captureKernelWorker(page);
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
});

test("peak normalization has independent subset output goldens and exact undo/redo", async ({
  page,
}) => {
  await load(page);
  await select(page, 2, 6);
  await (
    await revealControl(
      page.getByRole("button", { name: "Right", exact: true, includeHidden: true }),
    )
  ).click();
  const before = await info(page),
    saved = await history(page);
  const dialog = await normalize(page, "normalize-peak", "-6.020599913279624");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  // Independent IEEE float32 vector for one linked gain2/3: selected peak
  // .75 becomes .5; untouched channel/boundaries retain original bits.
  const golden = [
    LEFT,
    [-1, -0.875, -0.5, -0.4166666567325592, -0.3333333432674408, -0.25, -0.25, -0.125],
  ];
  expect(await samples(page)).toEqual(golden);
  expect((await info(page)).documentId).not.toBe(before.documentId);
  expect((await history(page)).entries).toHaveLength(saved.entries.length + 1);
  await page.getByTestId("document-details").click();
  await page.keyboard.press("Control+z");
  await expect.poll(() => samples(page)).toEqual([LEFT, RIGHT]);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(() => samples(page)).toEqual(golden);
});

test("LUFS normalization reports truthful linked source/output telemetry and reaches EBU tone calibration", async ({
  page,
}) => {
  await load(page, tone(48000 * 2));
  const before = await info(page),
    saved = await history(page);
  const dialog = await normalize(page, "normalize-loudness");
  await expect(dialog.getByLabel("Target loudness (LUFS)")).toHaveValue("-23");
  await dialog.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(dialog.getByTestId("process-status")).toContainText("Previewing");
  const sourceReading = await dialog.getByText(/Source integrated loudness:/).textContent();
  expect(Math.abs(Number(sourceReading?.match(/(-?\d+\.\d+) LUFS/)?.[1]) + 33)).toBeLessThan(0.1);
  const predicted = dialog.getByText(/Predicted output loudness:/);
  const measured = dialog.getByText(/Measured output loudness:/);
  expect((await predicted.count()) + (await measured.count())).toBeGreaterThan(0);
  expect(await info(page)).toEqual(before);
  expect(await history(page)).toEqual(saved);
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const output = await samples(page);
  expect(output[0]).toEqual(output[1]);
  // Independent official calibration: stereo1kHz−23dBFS peak is−23LUFS.
  const expectedPeak = 10 ** (-23 / 20);
  expect(output[0][12]).toBeCloseTo(expectedPeak, 3);
  expect((await history(page)).entries).toHaveLength(saved.entries.length + 1);
});

test("positive below-gate source normalizes without an invented source LUFS reading", async ({
  page,
}) => {
  await load(page, tone(48000, -100));
  const before = await info(page),
    saved = await history(page);
  const dialog = await normalize(page, "normalize-loudness");
  await dialog.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(dialog.getByTestId("process-status")).toContainText("Previewing");
  await expect(
    dialog.getByText("Source loudness unavailable: below the absolute gate"),
  ).toBeVisible();
  await expect(dialog.getByText(/Source integrated loudness:/)).toHaveCount(0);
  expect(await info(page)).toEqual(before);
  expect(await history(page)).toEqual(saved);
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect((await samples(page))[0][12]).toBeCloseTo(10 ** (-23 / 20), 3);
});

test("silence normalization is an explicit clean unchanged result", async ({ page }) => {
  await load(page, [Array(48000).fill(0), Array(48000).fill(0)]);
  const before = await info(page),
    saved = await history(page);
  const dialog = await normalize(page, "normalize-loudness");
  await dialog.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(dialog.getByText("Source loudness unavailable: silence")).toBeVisible();
  await expect(
    dialog.getByText(/Resolved gain|Measured output loudness|Source integrated loudness/),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(await info(page)).toEqual(before);
  expect(await history(page)).toEqual(saved);
  await expect(page.getByTestId("history-dirty")).toHaveText("Saved");
});

test("normalization preview uses real worklet samples and Cancel preserves the saved source", async ({
  page,
}) => {
  await capturePlayback(page);
  await page.reload();
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
  await page
    .getByTestId("audio-file-input")
    .setInputFiles({ name: "normalize-preview.wav", mimeType: "audio/wav", buffer: playbackWAV() });
  await expect(page.getByTestId("document-name")).toHaveText("normalize-preview.wav");
  const before = await info(page),
    saved = await history(page);
  const dialog = await normalize(page, "normalize-peak", "-12.041199826559248");
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
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).not.toBeVisible();
  expect(await history(page)).toEqual(saved);
  await page.getByTestId("play").click();
  await expect.poll(levels).toEqual([0.5, -0.25]);
  await page.getByTestId("stop").click();
});

test("short or nonfinite LUFS input reports an error without changing source/history", async ({
  page,
}) => {
  for (const channels of [
    [LEFT, RIGHT],
    [
      [...Array(48000).fill(0.1), Number.NaN],
      [...Array(48000).fill(0.1), 0.1],
    ],
  ]) {
    await load(page, channels);
    const before = await info(page),
      saved = await history(page);
    const dialog = await normalize(page, "normalize-loudness");
    await dialog.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(page.getByText(/Could not process audio/).first()).toBeVisible();
    await expect(dialog.getByTestId("process-status")).toHaveText("Ready to process");
    expect(await info(page)).toEqual(before);
    expect(await history(page)).toEqual(saved);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).not.toBeVisible();
  }
});

for (const phase of ["analyzing", "processing"] as const) {
  test(`Cancel overtakes actual normalization ${phase} slices`, async ({ page }) => {
    await page.getByTestId("audio-file-input").setInputFiles({
      name: "normalize-cancel.wav",
      mimeType: "audio/wav",
      buffer: playbackWAV(48000 * 10),
    });
    await expect(page.getByTestId("document-name")).toHaveText("normalize-cancel.wav");
    const before = await info(page),
      saved = await history(page);
    const dialog = await normalize(page, "normalize-loudness");
    await page.evaluate((desiredPhase) => {
      const worker = window.__aaeTest?.workers[0];
      if (!worker) throw new Error("worker missing");
      const cancelOnProgress = (event: MessageEvent) => {
        if (event.data.kind !== "process.progress" || event.data.progress.phase !== desiredPhase)
          return;
        worker.removeEventListener("message", cancelOnProgress);
        Array.from(document.querySelectorAll<HTMLButtonElement>("dialog[open] button"))
          .find((button) => button.textContent === "Cancel")
          ?.click();
      };
      worker.addEventListener("message", cancelOnProgress);
    }, phase);
    await dialog.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(await info(page)).toEqual(before);
    expect(await history(page)).toEqual(saved);
  });
}
