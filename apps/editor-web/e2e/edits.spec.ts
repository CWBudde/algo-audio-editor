/// <reference lib="dom" />

import { expect, test } from "@playwright/test";
import { clipboard, edit, info, LEFT, load, RIGHT, samples, select } from "./edit-fixture.ts";
import { captureKernelWorker } from "./kernel-probe.ts";
import { revealControl } from "./ui-disclosures.ts";

test.beforeEach(async ({ page }) => {
  await captureKernelWorker(page);
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
});

test("cut and paste restore exact samples, copy preserves identity, and replace/mix are unclamped", async ({
  page,
}) => {
  await load(page);
  await select(page, 2, 6);
  const original = (await info(page)).documentId;
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect.poll(async () => (await clipboard(page)).frames).toBe(4);
  expect((await info(page)).documentId).toBe(original);
  await edit(page, "Cut", 4);
  expect(await samples(page)).toEqual([
    [0.125, 0.25, 0.875, 1],
    [-1, -0.875, -0.25, -0.125],
  ]);
  const copied = await clipboard(page);
  await edit(page, "Paste", 8);
  expect(await samples(page)).toEqual([LEFT, RIGHT]);
  expect(await clipboard(page)).toEqual(copied);
  await select(page, 0, 2);
  await edit(page, "Replace with clipboard", 10);
  expect(await samples(page)).toEqual([
    [...LEFT.slice(2, 6), ...LEFT.slice(2)],
    [...RIGHT.slice(2, 6), ...RIGHT.slice(2)],
  ]);
  await select(page, 0, 0);
  await edit(page, "Mix clipboard", 10);
  const mixed = await samples(page);
  expect(mixed[0].slice(0, 4)).toEqual([0.75, 1, 1.25, 1.5]);
  expect(mixed[1].slice(0, 4)).toEqual([-1.5, -1.25, -1, -0.75]);
});

test("channel-only edits keep other channel positions and pad only at EOF; crop affects all channels", async ({
  page,
}) => {
  await load(page);
  await select(page, 1, 3);
  await (await revealControl(page.getByRole("button", { name: "Left", exact: true }))).click();
  await edit(page, "Mute", 8);
  expect(await samples(page)).toEqual([[0.125, 0, 0, ...LEFT.slice(3)], RIGHT]);
  await select(page, 3, 5);
  await edit(page, "Duplicate", 10);
  const duplicated = [0.125, 0, 0, 0.5, 0.625, 0.5, 0.625, 0.75, 0.875, 1];
  expect(await samples(page)).toEqual([duplicated, [...RIGHT, 0, 0]]);
  await select(page, 1, 1);
  await (await revealControl(page.getByLabel("Silence frames", { exact: true }))).fill("2");
  await edit(page, "Insert silence", 12);
  expect(await samples(page)).toEqual([
    [0.125, 0, 0, ...duplicated.slice(1)],
    [...RIGHT, 0, 0, 0, 0],
  ]);
  await select(page, 3, 7);
  await edit(page, "Crop time (all channels)", 4);
  expect(await samples(page)).toEqual([[0, 0, 0.5, 0.625], RIGHT.slice(3, 7)]);
  await (await revealControl(page.getByRole("button", { name: "All", exact: true }))).click();
  await select(page, 1, 3);
  await edit(page, "Swap selected channels", 4);
  expect(await samples(page)).toEqual([
    [0, -0.5, -0.375, 0.625],
    [-0.625, 0, 0.5, -0.25],
  ]);
  await edit(page, "Delete", 2);
  expect(await samples(page)).toEqual([
    [0, 0.625],
    [-0.625, -0.25],
  ]);
});

test("channel conversion requires confirmation and cancellation leaves document and clipboard intact", async ({
  page,
}) => {
  await load(page);
  await select(page, 1, 3);
  await (await revealControl(page.getByRole("button", { name: "Left", exact: true }))).click();
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect.poll(async () => (await clipboard(page)).channels).toBe(1);
  await (await revealControl(page.getByRole("button", { name: "All", exact: true }))).click();
  await select(page, 0, 0);
  const before = await info(page);
  const copied = await clipboard(page);
  await page.getByRole("button", { name: "Paste", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Convert clipboard", exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("button", { name: "Cut", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await info(page)).toEqual(before);
  expect(await clipboard(page)).toEqual(copied);
  await page.getByRole("button", { name: "Paste", exact: true }).click();
  await dialog.getByRole("button", { name: "Convert and paste", exact: true }).click();
  await expect(page.getByTestId("document-details")).toContainText("· 10 frames");
  expect(await samples(page)).toEqual([
    [0.25, 0.375, ...LEFT],
    [0.25, 0.375, ...RIGHT],
  ]);
  expect(await clipboard(page)).toEqual(copied);
});

test("clipboard survives open, rate conversion is explicit, and an empty document accepts paste", async ({
  page,
}) => {
  await load(page, [Array(48_000).fill(0.125)]);
  await select(page, 0, 48_000);
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect.poll(async () => (await clipboard(page)).frames).toBe(48_000);
  const copied = await clipboard(page);
  await load(page, [Array(24_000).fill(0.25)], 24_000);
  await page.getByRole("button", { name: "Paste", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Convert clipboard", exact: true });
  await expect(dialog).toContainText("48000 Hz");
  await expect(dialog).toContainText("24000 Hz");
  await dialog.getByRole("button", { name: "Convert and paste", exact: true }).click();
  await expect(page.getByTestId("document-details")).toContainText("· 48000 frames");
  const converted = (await samples(page))[0];
  expect(converted[12_000]).toBeCloseTo(0.125, 6);
  expect(converted.slice(24_000)).toEqual(Array(24_000).fill(0.25));
  expect(await clipboard(page)).toEqual(copied);
  await load(page, [[]]);
  await edit(page, "Paste", 48_000);
  expect((await samples(page))[0]).toEqual(Array(48_000).fill(0.125));
  await (await revealControl(page.getByLabel("Silence frames", { exact: true }))).fill("1.5");
  await expect(page.getByRole("button", { name: "Insert silence", exact: true })).toBeDisabled();
});

test("copy shortcuts retain playback while audio-changing shortcuts stop it", async ({ page }) => {
  await load(page, [Array(48_000).fill(0.125), Array(48_000).fill(-0.25)]);
  await select(page, 0, 24_000);
  await page.getByLabel("Loop", { exact: true }).check();
  await page.getByTestId("play").click();
  await expect
    .poll(async () => Number(await page.getByTestId("frames-played").textContent()))
    .toBeGreaterThan(0);
  const before = await info(page);
  const played = Number(await page.getByTestId("frames-played").textContent());
  await page.keyboard.press("Control+c");
  await expect.poll(async () => (await clipboard(page)).frames).toBe(24_000);
  expect((await info(page)).documentId).toBe(before.documentId);
  await expect(page.getByTestId("stop")).toBeEnabled();
  await expect
    .poll(async () => Number(await page.getByTestId("frames-played").textContent()))
    .toBeGreaterThan(played);
  await page.keyboard.press("Control+x");
  await expect(page.getByTestId("document-details")).toContainText("· 24000 frames");
  await expect(page.getByTestId("stop")).toBeDisabled();
  await page.keyboard.press("Control+v");
  await expect(page.getByTestId("document-details")).toContainText("· 48000 frames");
  expect(await samples(page)).toEqual([Array(48_000).fill(0.125), Array(48_000).fill(-0.25)]);
});

test("keyboard edits cannot capture a pointer preview before pointerup", async ({ page }) => {
  await load(page);
  const bounds = await page.getByTestId("waveform-channel-0").boundingBox();
  if (!bounds) throw new Error("missing waveform");
  const y = bounds.y + Math.min(bounds.height / 2, 40);
  await page.mouse.move(bounds.x + bounds.width / 4, y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + (bounds.width * 3) / 4, y, { steps: 3 });
  await page.keyboard.press("Control+c");
  // A probe after the key sees all previously queued worker calls.
  expect((await clipboard(page)).available).toBe(false);
  await page.mouse.up();
  await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-selection-start", "2");
  await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-selection-end", "6");
  await page.keyboard.press("Control+c");
  await expect.poll(async () => (await clipboard(page)).frames).toBe(4);
});

test("oversized mix rejects safely without changing the document or clipboard", async ({
  page,
}) => {
  await load(page);
  // Shared silence represents this duration cheaply; mixing would newly
  // materialize more than 512 MiB of stereo samples without the kernel guard.
  await (await revealControl(page.getByLabel("Silence frames", { exact: true }))).fill("67108865");
  await edit(page, "Insert silence", 67_108_873);
  await select(page, 0, 67_108_873);
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect.poll(async () => (await clipboard(page)).frames).toBe(67_108_873);
  await select(page, 0, 0);
  const before = await info(page);
  const copied = await clipboard(page);
  await (
    await revealControl(page.getByRole("button", { name: "Mix clipboard", exact: true }))
  ).click();
  await expect(page.getByText("Could not paste-mix", { exact: true })).toBeVisible();
  await expect(page.getByText(/materialized.*budget|budget.*materialized/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Paste", exact: true })).toBeEnabled();
  expect(await info(page)).toEqual(before);
  expect(await clipboard(page)).toEqual(copied);
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
});
