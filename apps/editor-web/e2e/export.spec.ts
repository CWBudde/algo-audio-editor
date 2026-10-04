/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import { info, LEFT, load, RIGHT, samples, select } from "./edit-fixture.ts";
import { exportDownload, openExport, parseWAV, sourceState } from "./export-fixture.ts";
import { captureKernelWorker } from "./kernel-probe.ts";
import { revealControl } from "./ui-disclosures.ts";

test.beforeEach(async ({ page }) => {
  await captureKernelWorker(page);
  await page.addInitScript(() => Object.assign(window, { showSaveFilePicker: undefined }));
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
});
for (const [encoding, depths] of [
  ["pcm", [8, 16, 24, 32]],
  ["float", [32, 64]],
] as const) {
  for (const depth of depths)
    test(`Export dialog writes real ${depth}-bit WAV ${encoding} without changing its source`, async ({
      page,
    }) => {
      await load(page);
      const before = await sourceState(page);
      const dialog = await openExport(page);
      await expect(dialog.getByLabel("Format", { exact: true })).toHaveValue("float");
      await expect(dialog.getByLabel("Bit depth", { exact: true })).toHaveValue("32");
      await dialog.getByLabel("Format", { exact: true }).selectOption(encoding);
      await dialog.getByLabel("Bit depth", { exact: true }).selectOption(String(depth));
      const { bytes, download } = await exportDownload(page);
      expect(download.suggestedFilename()).toBe("edit-48000.wav");
      const output = parseWAV(bytes);
      expect(output).toMatchObject({
        tag: encoding === "float" ? 3 : 1,
        channels: 2,
        sampleRate: 48000,
        bitDepth: depth,
        frames: 8,
      });
      if (encoding === "pcm" && depth === 8) {
        // PCM8 uses signed 128-step quantization with an unsigned midpoint of 128.
        expect(output.data).toEqual(
          Buffer.from([144, 0, 160, 16, 176, 32, 192, 48, 208, 64, 224, 80, 240, 96, 255, 112]),
        );
      } else {
        expect(output.samples).toEqual([
          LEFT.map((value) => (encoding === "pcm" ? Math.min(value, 1 - 2 ** (1 - depth)) : value)),
          RIGHT,
        ]);
      }
      expect(await sourceState(page)).toEqual(before);
      expect(await samples(page)).toEqual([LEFT, RIGHT]);
    });
}
test("selection exports the live right channel and cropped/rebased WAV annotations without editing history", async ({
  page,
}) => {
  await load(page);
  for (const [kind, start, end, name] of [
    ["marker", 3, 3, "Inside cue"],
    ["marker", 7, 7, "Outside cue"],
    ["region", 1, 7, "Spanning region"],
  ] as const) {
    await select(page, start, end);
    await (await revealControl(page.getByLabel("Marker or region name"))).fill(name);
    await page.getByRole("button", { name: `Add ${kind}`, exact: true }).click();
    await expect
      .poll(async () =>
        (await sourceState(page)).timeline[kind === "marker" ? "markers" : "regions"].some(
          (item) => item.name === name,
        ),
      )
      .toBe(true);
  }
  await select(page, 2, 6);
  await (
    await revealControl(
      page.getByRole("button", { name: "Right", exact: true, includeHidden: true }),
    )
  ).click();
  const before = await sourceState(page);
  const dialog = await openExport(page);
  await dialog.getByLabel("Range", { exact: true }).selectOption("selection");
  await expect(dialog).toContainText("Frames 2–6 · channels 2");
  const { bytes, download } = await exportDownload(page);
  expect(download.suggestedFilename()).toBe("edit-48000-selection.wav");
  expect(parseWAV(bytes)).toMatchObject({ channels: 1, frames: 4, samples: [RIGHT.slice(2, 6)] });
  expect(await sourceState(page)).toEqual(before);
  expect(await samples(page)).toEqual([LEFT, RIGHT]);
  await expect(page.getByTestId("history-dirty")).toHaveText("Unsaved changes");
  await page
    .getByTestId("audio-file-input")
    .setInputFiles({ name: download.suggestedFilename(), mimeType: "audio/wav", buffer: bytes });
  await expect.poll(async () => (await info(page)).documentId).not.toBe(before.document.documentId);
  const reopened = (await sourceState(page)).timeline;
  expect(reopened.markers).toEqual([expect.objectContaining({ name: "Inside cue", frame: 1 })]);
  expect(reopened.regions).toEqual([
    expect.objectContaining({ name: "Spanning region", start: 0, end: 4 }),
  ]);
});
test("all dither distributions and noise shapers write bounded quantized audio and float clears quality choices", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const quiet = Array.from({ length: 512 }, (_, index) => (index % 2 ? -1 : 1) / 131072);
  await load(page, [quiet]);
  const before = await sourceState(page);
  let dialog = await openExport(page);
  await dialog.getByLabel("Format", { exact: true }).selectOption("pcm");
  await dialog.getByLabel("Bit depth", { exact: true }).selectOption("16");
  const baseline = parseWAV((await exportDownload(page)).bytes).data;
  for (const [dither, shaping] of [
    ...["rectangular", "triangular", "gaussian", "fast-gaussian"].map((dither) => [dither, "none"]),
    ...["efb", "2sc", "9fc", "sbm", "sharp"].map((shaping) => ["triangular", shaping]),
  ]) {
    dialog = await openExport(page);
    await dialog.getByLabel("Format", { exact: true }).selectOption("pcm");
    await dialog.getByLabel("Bit depth", { exact: true }).selectOption("16");
    await dialog.getByLabel("Dither", { exact: true }).selectOption(dither);
    await dialog.getByLabel("Noise shaping", { exact: true }).selectOption(shaping);
    const output = parseWAV((await exportDownload(page)).bytes);
    expect(output.data.equals(baseline)).toBe(false);
    expect(
      output.samples[0].every((value) => Number.isFinite(value) && Math.abs(value) < 0.01),
    ).toBe(true);
  }
  dialog = await openExport(page);
  await dialog.getByLabel("Format", { exact: true }).selectOption("pcm");
  await dialog.getByLabel("Dither", { exact: true }).selectOption("triangular");
  await dialog.getByLabel("Noise shaping", { exact: true }).selectOption("sharp");
  await dialog.getByLabel("Format", { exact: true }).selectOption("float");
  await expect(dialog.getByLabel("Dither", { exact: true })).toHaveCount(0);
  await dialog.getByLabel("Bit depth", { exact: true }).selectOption("64");
  const output = parseWAV((await exportDownload(page)).bytes);
  expect(output.samples).toEqual([quiet]);
  expect(await sourceState(page)).toEqual(before);
});
test("keyboard opens a fenced modal without a chooser, disables cursor range and restores focus on Escape", async ({
  page,
}) => {
  await load(page);
  const before = await sourceState(page);
  const opener = page.getByLabel("Selection start", { exact: true });
  await opener.focus();
  await page.keyboard.press("Control+Shift+E");
  const dialog = page.getByRole("dialog", { name: "Export audio" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("option", { name: "Selection (selected channels)" }),
  ).toBeDisabled();
  await page.keyboard.press("Control+s");
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Command palette" })).not.toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(opener).toBeFocused();
  expect(await sourceState(page)).toEqual(before);
});
test("chooser cancellation and write failure retain editable settings and allow retry without a save acknowledgement", async ({
  page,
}) => {
  await page.evaluate(() => {
    let attempt = 0;
    Object.assign(window, {
      __exportPickerCalls: 0,
      showSaveFilePicker: async () => {
        Object.assign(window, { __exportPickerCalls: ++attempt });
        if (attempt === 1) throw new DOMException("cancelled", "AbortError");
        if (attempt === 2)
          return {
            createWritable: async () => ({
              write: async () => {
                throw new Error("disk full");
              },
              close: async () => {},
            }),
          };
        return { createWritable: async () => ({ write: async () => {}, close: async () => {} }) };
      },
    });
  });
  await load(page);
  const before = await sourceState(page);
  const dialog = await openExport(page);
  await dialog.getByLabel("Format", { exact: true }).selectOption("pcm");
  await dialog.getByLabel("Bit depth", { exact: true }).selectOption("16");
  expect(
    await page.evaluate(
      () => (window as unknown as { __exportPickerCalls: number }).__exportPickerCalls,
    ),
  ).toBe(0);
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("Ready to export");
  await expect(dialog.getByLabel("Bit depth", { exact: true })).toHaveValue("16");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("disk full");
  await expect(dialog.getByLabel("Bit depth", { exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(await sourceState(page)).toEqual(before);
});
