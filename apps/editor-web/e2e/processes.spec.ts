/// <reference lib="dom" />
import type { BinaryDocumentResult, HistoryListResult, ProcessJobResult } from "@aae/protocol";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { info, LEFT, load, RIGHT, samples, select } from "./edit-fixture.ts";
import { captureKernelWorker } from "./kernel-probe.ts";
import { revealControl } from "./ui-disclosures.ts";

declare global {
  interface Window {
    __aaeProcessJob?: ProcessJobResult;
  }
}

async function history(page: Page) {
  const document = await info(page);
  return page.evaluate(
    async (documentId) =>
      (await window.__aaeTest?.request("history.list", { documentId })) as HistoryListResult,
    document.documentId,
  );
}

async function open(page: Page, command: string) {
  await page.getByRole("menuitem", { name: "Process", exact: true }).click();
  await page.locator(`[role="menuitem"][data-command-id="process.${command}"]`).click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toBeVisible();
  return dialog;
}

async function apply(page: Page, dialog: Locator) {
  const before = await history(page);
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect
    .poll(async () => (await history(page)).entries.length)
    .toBe(before.entries.findIndex((entry) => entry.stateId === before.currentStateId) + 2);
}

async function undo(page: Page, source = [LEFT, RIGHT]) {
  await page.getByTestId("document-details").click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => samples(page)).toEqual(source);
}

async function rightOnly(page: Page) {
  await (
    await revealControl(
      page.getByRole("button", { name: "Right", exact: true, includeHidden: true }),
    )
  ).click();
}

test.beforeEach(async ({ page, context }) => {
  await captureKernelWorker(context);
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
});

for (const [command, expected] of [
  ["reverse", [-1, -0.875, -0.375, -0.5, -0.625, -0.75, -0.25, -0.125]],
  ["invert", [-1, -0.875, 0.75, 0.625, 0.5, 0.375, -0.25, -0.125]],
  ["remove-dc", [-1, -0.875, -0.1875, -0.0625, 0.0625, 0.1875, -0.25, -0.125]],
] as const)
  test(`${command} processes selected samples and channels with exact undo`, async ({ page }) => {
    await load(page);
    await select(page, 2, 6);
    await rightOnly(page);
    await apply(page, await open(page, command));
    expect(await samples(page)).toEqual([LEFT, Array.from(expected)]);
    await undo(page);
  });

for (const curve of ["linear", "equal-power", "logarithmic", "s-curve"])
  test(`fade ${curve} has explicit selection endpoints and preserves other channels`, async ({
    page,
  }) => {
    await load(page);
    await select(page, 2, 6);
    await rightOnly(page);
    const dialog = await open(page, "fade");
    await dialog.getByLabel("Curve", { exact: true }).selectOption(curve);
    await apply(page, dialog);
    const output = await samples(page);
    expect(output[0]).toEqual(LEFT);
    expect(output[1].slice(0, 2)).toEqual(RIGHT.slice(0, 2));
    expect(output[1].slice(6)).toEqual(RIGHT.slice(6));
    expect(output[1][2]).toBe(-0);
    expect(output[1][5]).toBe(RIGHT[5]);
    if (curve === "linear") {
      expect(output[1][3]).toBeCloseTo(Math.fround(RIGHT[3] / 3), 8);
      expect(output[1][4]).toBeCloseTo(Math.fround((RIGHT[4] * 2) / 3), 8);
    }
    await undo(page);
    const out = await open(page, "fade");
    await out.getByLabel("Direction", { exact: true }).selectOption("fade-out");
    await out.getByLabel("Curve", { exact: true }).selectOption(curve);
    await apply(page, out);
    expect((await samples(page))[1][2]).toBe(RIGHT[2]);
    expect((await samples(page))[1][5]).toBe(-0);
  });

test("cursor crossfade splices both channels and shortens by exactly one overlap", async ({
  page,
}) => {
  await load(page);
  await select(page, 4, 4);
  const dialog = await open(page, "crossfade");
  await dialog.getByLabel("Overlap duration (seconds)").fill(String(2 / 48000));
  await apply(page, dialog);
  expect((await info(page)).frames).toBe(6);
  expect(await samples(page)).toEqual([
    [0.125, 0.25, 0.375, 0.75, 0.875, 1],
    [-1, -0.875, -0.75, -0.375, -0.25, -0.125],
  ]);
  await undo(page);
});

test("whole-document mono duplication and stereo mix/left/right conversion preserve exact history", async ({
  page,
}) => {
  await load(page, [LEFT]);
  await apply(page, await open(page, "mono-to-stereo"));
  expect((await info(page)).channels).toBe(2);
  expect(await samples(page)).toEqual([LEFT, LEFT]);
  await undo(page, [LEFT]);
  for (const mode of ["mix", "left", "right"]) {
    await load(page);
    await select(page, 2, 4);
    const dialog = await open(page, "stereo-to-mono");
    await dialog.getByLabel("Mono source").selectOption(mode);
    await apply(page, dialog);
    expect((await info(page)).channels).toBe(1);
    expect(await samples(page)).toEqual([
      mode === "left"
        ? LEFT
        : mode === "right"
          ? RIGHT
          : LEFT.map((sample, index) => (sample + RIGHT[index]) / 2),
    ]);
    await undo(page);
  }
});

for (const quality of ["fast", "balanced", "best"])
  test(`sample rate ${quality} maps duration and remains undoable`, async ({ page }) => {
    const source = [
      Array.from({ length: 128 }, () => 0.25),
      Array.from({ length: 128 }, () => -0.125),
    ];
    await load(page, source);
    const dialog = await open(page, "resample");
    await dialog.getByLabel("Sample rate (Hz)").fill("24000");
    await dialog.getByLabel("Quality").selectOption(quality);
    await apply(page, dialog);
    expect(await info(page)).toMatchObject({ sampleRate: 24000, channels: 2, frames: 64 });
    const output = await samples(page);
    expect(output).toHaveLength(2);
    expect(output[0]).toHaveLength(64);
    expect(output.flat().every(Number.isFinite)).toBe(true);
    await undo(page, source);
    expect((await info(page)).sampleRate).toBe(48000);
  });

test("silence and sine generation replace exactly the selected channel range", async ({ page }) => {
  await load(page);
  await select(page, 2, 6);
  await rightOnly(page);
  let dialog = await open(page, "generate");
  await dialog.getByLabel("Generator", { exact: true }).selectOption("silence");
  await apply(page, dialog);
  expect(await samples(page)).toEqual([LEFT, [-1, -0.875, 0, 0, 0, 0, -0.25, -0.125]]);
  await undo(page);
  dialog = await open(page, "generate");
  await dialog.getByLabel("Frequency (Hz)").fill("12000");
  await dialog.getByLabel("Level (dBFS)").fill("-6.020599913279624");
  await apply(page, dialog);
  const output = await samples(page);
  expect(output[0]).toEqual(LEFT);
  for (const [index, expected] of [
    [2, 0],
    [3, 0.5],
    [4, 0],
    [5, -0.5],
  ])
    expect(output[1][index]).toBeCloseTo(expected, 7);
  expect(output[1].slice(6)).toEqual(RIGHT.slice(6));
});

test("generation fills an empty document using its current format and pads unselected channels", async ({
  page,
}) => {
  await load(page, [[], []]);
  await rightOnly(page);
  const dialog = await open(page, "generate");
  await dialog.getByLabel("Duration (seconds)").fill(String(4 / 48000));
  await dialog.getByLabel("Frequency (Hz)").fill("12000");
  await dialog.getByLabel("Level (dBFS)").fill("-6.020599913279624");
  await apply(page, dialog);
  expect(await info(page)).toMatchObject({ sampleRate: 48000, channels: 2, frames: 4 });
  const output = await samples(page);
  expect(output[0]).toEqual([0, 0, 0, 0]);
  for (const [index, expected] of [
    [0, 0],
    [1, 0.5],
    [2, 0],
    [3, -0.5],
  ])
    expect(output[1][index]).toBeCloseTo(expected, 7);
  await undo(page, [[], []]);
});

for (const generator of ["white-noise", "pink-noise", "linear-sweep", "log-sweep"])
  test(`${generator} preview and Apply retain exact private candidate samples`, async ({
    page,
  }) => {
    await load(page);
    await select(page, 2, 6);
    await page.evaluate(() => {
      window.__aaeTest?.workers[0].addEventListener("message", (event: MessageEvent) => {
        if (event.data.kind === "process.progress") window.__aaeProcessJob = event.data.progress;
      });
    });
    const dialog = await open(page, "generate");
    await dialog.getByLabel("Generator", { exact: true }).selectOption(generator);
    if (generator.includes("sweep")) await dialog.getByLabel("End frequency (Hz)").fill("12000");
    const before = await history(page);
    await dialog.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(dialog.getByTestId("process-status")).toContainText("Previewing");
    expect(await history(page)).toEqual(before);
    const candidate = await page.evaluate(async () => {
      const job = window.__aaeProcessJob;
      if (!job) throw new Error("Missing process progress");
      const output = (await window.__aaeTest?.request("process.exportCandidate", {
        documentId: job.documentId,
        jobId: job.jobId,
      })) as BinaryDocumentResult;
      const view = new DataView(output.data);
      return Array.from({ length: output.channels }, (_, channel) =>
        Array.from({ length: output.frames }, (_, frame) =>
          view.getFloat32(4 * (channel * output.frames + frame), true),
        ),
      );
    });
    await dialog.getByRole("button", { name: "Stop preview" }).click();
    await apply(page, dialog);
    expect(await samples(page)).toEqual(candidate);
    expect(candidate.flat().every(Number.isFinite)).toBe(true);
    if (generator.includes("noise"))
      expect(candidate[0].slice(2, 6)).not.toEqual(candidate[1].slice(2, 6));
    await undo(page);
  });

test("cursor generation inserts requested duration and channel extraction opens an unsaved second editor", async ({
  page,
  context,
}) => {
  await load(page);
  await select(page, 4, 4);
  const generator = await open(page, "generate");
  await generator.getByLabel("Generator", { exact: true }).selectOption("silence");
  await generator.getByLabel("Duration (seconds)").fill(String(2 / 48000));
  await apply(page, generator);
  expect((await info(page)).frames).toBe(10);
  expect(await samples(page)).toEqual([
    LEFT.slice(0, 4).concat([0, 0], LEFT.slice(4)),
    RIGHT.slice(0, 4).concat([0, 0], RIGHT.slice(4)),
  ]);
  await undo(page);
  await select(page, 2, 6);
  const before = await info(page);
  const saved = await history(page);
  const dialog = await open(page, "extract-channel");
  await dialog.getByLabel("Channel", { exact: true }).selectOption("1");
  const next = context.waitForEvent("page");
  await dialog.getByRole("button", { name: "Open extracted channel" }).click();
  const child = await next;
  await expect(child.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
  await expect(dialog).not.toBeVisible();
  expect(await samples(child)).toEqual([RIGHT.slice(2, 6)]);
  expect(await info(child)).toMatchObject({ sampleRate: 48000, channels: 1, frames: 4 });
  expect((await history(child)).dirty).toBe(true);
  expect(await info(page)).toEqual(before);
  expect(await history(page)).toEqual(saved);
  await child.close();
});

test("blocked extraction popups leave the source and history unchanged", async ({ page }) => {
  await load(page);
  const before = await info(page);
  const saved = await history(page);
  await page.evaluate(() => {
    window.open = () => null;
  });
  const dialog = await open(page, "extract-channel");
  await dialog.getByRole("button", { name: "Open extracted channel" }).click();
  await expect(
    page.getByText("The extraction window was blocked. Allow editor popups and try again.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(await info(page)).toEqual(before);
  expect(await history(page)).toEqual(saved);
  expect(await samples(page)).toEqual([LEFT, RIGHT]);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).not.toBeVisible();
});

test("closing an extraction destination before import preserves the source", async ({
  page,
  context,
}) => {
  await load(page);
  const before = await info(page);
  const saved = await history(page);
  await context.route(
    (url) => url.searchParams.has("extract"),
    (route) => route.abort(),
  );
  const dialog = await open(page, "extract-channel");
  const next = context.waitForEvent("page");
  await dialog.getByRole("button", { name: "Open extracted channel" }).click();
  const child = await next;
  await child.close();
  await expect(page.getByText("The extraction window was closed.", { exact: true })).toBeVisible();
  expect(await info(page)).toEqual(before);
  expect(await history(page)).toEqual(saved);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
});
