/// <reference lib="dom" />

import type {
  DocumentInfoResult,
  HistoryListResult,
  SelectionResult,
  TimelineResult,
} from "@aae/protocol";
import { type Download, expect, type Page, test } from "@playwright/test";
import {
  clipboard,
  edit,
  fixture,
  info,
  LEFT,
  load,
  RIGHT,
  samples,
  select,
} from "./edit-fixture.ts";
import { captureKernelWorker } from "./kernel-probe.ts";
import { revealControl } from "./ui-disclosures.ts";

async function history(page: Page) {
  return page.evaluate(async () => {
    const document = (await window.__aaeTest?.request("doc.info")) as DocumentInfoResult;
    return (await window.__aaeTest?.request("history.list", {
      documentId: document.documentId,
    })) as HistoryListResult;
  });
}

async function editorState(page: Page) {
  return page.evaluate(async () => {
    const document = (await window.__aaeTest?.request("doc.info")) as DocumentInfoResult;
    const range = (await window.__aaeTest?.request("selection.get", {
      documentId: document.documentId,
    })) as SelectionResult;
    const timeline = (await window.__aaeTest?.request("timeline.get", {
      documentId: document.documentId,
    })) as TimelineResult;
    return {
      range: { start: range.start, end: range.end, channelMask: range.channelMask },
      markers: timeline.markers,
      regions: timeline.regions,
    };
  });
}

async function navigate(page: Page, action: () => Promise<unknown>) {
  const previous = (await info(page)).documentId;
  await action();
  await expect.poll(async () => (await info(page)).documentId).not.toBe(previous);
  await expect(page.getByLabel("Selection start", { exact: true })).toBeEnabled();
}

async function openPanel(page: Page) {
  await page.locator("aside[aria-label='Edit history'] summary").click();
}

async function save(page: Page) {
  await page.getByRole("menuitem", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Save\b/ }).click();
}

async function bytes(download: Download) {
  const stream = await download.createReadStream();
  if (!stream) throw new Error("download stream missing");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test.beforeEach(async ({ page }) => {
  await captureKernelWorker(page);
  await page.addInitScript(() => Object.assign(window, { showSaveFilePicker: undefined }));
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
});

for (const operation of [
  { name: "Delete", frames: 4 },
  { name: "Cut", frames: 4 },
  { name: "Mute", frames: 8 },
  { name: "Crop time (all channels)", frames: 4 },
  { name: "Duplicate", frames: 12 },
  { name: "Swap selected channels", frames: 8 },
  { name: "Insert silence", frames: 10 },
  { name: "Paste", frames: 10, copy: true },
  { name: "Replace with clipboard", frames: 6, copy: true },
  { name: "Mix clipboard", frames: 8, copy: true },
]) {
  test(`${operation.name}: undo/redo restores exact audio, selection and anchors`, async ({
    page,
  }) => {
    await load(page);
    if (operation.copy) {
      await select(page, 1, 3);
      await page.getByRole("button", { name: "Copy", exact: true }).click();
      await expect.poll(async () => (await clipboard(page)).frames).toBe(2);
    }
    await select(page, 2, 6);
    await (await revealControl(page.getByLabel("Marker or region name"))).fill("History region");
    await page.getByRole("button", { name: "Add region", exact: true }).click();
    await expect(page.getByTestId("timeline-region-1")).toBeVisible();
    await (await revealControl(page.getByLabel("Marker or region name"))).fill("History cue");
    await page.getByRole("button", { name: "Add marker", exact: true }).click();
    await expect(page.getByTestId("timeline-marker-2")).toBeVisible();
    const before = await editorState(page);
    const beforeHistory = await history(page);
    expect(beforeHistory.entries).toHaveLength(3);
    expect(beforeHistory.dirty).toBe(true);
    if (operation.name === "Insert silence")
      await (await revealControl(page.getByLabel("Silence frames", { exact: true }))).fill("2");
    await edit(page, operation.name, operation.frames);
    const changed = await samples(page);
    const after = await editorState(page);
    const copied = await clipboard(page);
    const edited = await history(page);
    expect(edited.entries).toHaveLength(4);
    expect(edited.dirty).toBe(true); // Probe exports alone never mark saved.
    await expect(page.getByTestId("history-dirty")).toHaveText("Unsaved changes");
    await openPanel(page);
    await navigate(page, () =>
      page.getByRole("button", { name: "Undo edit", exact: true }).click(),
    );
    expect(await samples(page)).toEqual([LEFT, RIGHT]);
    expect(await editorState(page)).toEqual(before);
    expect(await clipboard(page)).toEqual(copied);
    expect((await history(page)).currentStateId).toBe(beforeHistory.currentStateId);
    expect((await history(page)).dirty).toBe(true);
    await expect(page.getByTestId("history-dirty")).toHaveText("Unsaved changes");
    await navigate(page, () => page.keyboard.press("Control+Shift+z"));
    expect(await samples(page)).toEqual(changed);
    expect(await editorState(page)).toEqual(after);
    expect(await clipboard(page)).toEqual(copied);
    expect((await history(page)).currentStateId).toBe(edited.currentStateId);
    await expect(page.getByTestId("history-dirty")).toHaveText("Unsaved changes");
  });
}

test("history rows jump both directions, branching removes redo, and input undo stays local", async ({
  page,
}) => {
  await load(page);
  const base = (await history(page)).currentStateId;
  await select(page, 1, 3);
  await edit(page, "Mute", 8);
  const muted = (await history(page)).currentStateId;
  await edit(page, "Duplicate", 10);
  const duplicate = await history(page);
  const duplicated = await samples(page);
  await openPanel(page);
  await navigate(page, () => page.getByTestId(`history-state-${base}`).click());
  expect(await samples(page)).toEqual([LEFT, RIGHT]);
  await expect(page.getByTestId(`history-state-${duplicate.currentStateId}`)).toHaveAttribute(
    "data-redo",
    "true",
  );
  await navigate(page, () => page.getByTestId(`history-state-${duplicate.currentStateId}`).click());
  expect(await samples(page)).toEqual(duplicated);
  await navigate(page, () =>
    page
      .getByRole("menuitem", { name: "Edit", exact: true })
      .click()
      .then(() => page.getByRole("menuitem", { name: /^Undo\b/ }).click()),
  );
  expect((await history(page)).currentStateId).toBe(muted);
  const input = page.getByLabel("Selection start", { exact: true });
  await input.focus();
  await page.keyboard.press("Control+z");
  expect((await history(page)).currentStateId).toBe(muted);
  await select(page, 4, 5);
  await edit(page, "Mute", 8);
  const branched = await history(page);
  expect(branched.canRedo).toBe(false);
  expect(branched.currentStateId).not.toBe(duplicate.currentStateId);
  await expect(page.getByTestId(`history-state-${duplicate.currentStateId}`)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Redo edit", exact: true })).toBeDisabled();
});

test("saving acknowledges only the written state and undo/redo tracks its save point", async ({
  page,
}) => {
  await load(page);
  await select(page, 2, 6);
  await edit(page, "Mute", 8);
  const savedSamples = await samples(page);
  const savingState = (await history(page)).currentStateId;
  const download = page.waitForEvent("download");
  await save(page);
  const saved = await bytes(await download);
  expect(saved.subarray(saved.length - 8 * 2 * 4)).toEqual(fixture(savedSamples).subarray(44));
  await expect(page.getByTestId("history-dirty")).toHaveText("Saved");
  expect((await history(page)).savedStateId).toBe(savingState);
  await expect(page).toHaveTitle("edit-48000.wav — algo-audio-editor");
  await navigate(page, () => page.keyboard.press("Control+z"));
  await expect(page.getByTestId("history-dirty")).toHaveText("Unsaved changes");
  await expect(page).toHaveTitle("* edit-48000.wav — algo-audio-editor");
  await navigate(page, () => page.keyboard.press("Control+y"));
  expect(await samples(page)).toEqual(savedSamples);
  await expect(page.getByTestId("history-dirty")).toHaveText("Saved");
  await select(page, 0, 1);
  await edit(page, "Mute", 8);
  await navigate(page, () => page.keyboard.press("Control+z"));
  expect((await history(page)).dirty).toBe(false);
});

test("cancelled and failed saves stay dirty, failed open retains history, reopening resets it", async ({
  page,
}) => {
  await load(page);
  await select(page, 1, 3);
  await edit(page, "Mute", 8);
  const current = await history(page);
  await page.evaluate(() =>
    Object.assign(window, {
      showSaveFilePicker: async () => {
        throw new DOMException("cancelled", "AbortError");
      },
    }),
  );
  await save(page);
  await expect(page.getByRole("button", { name: "Mute", exact: true })).toBeEnabled();
  expect(await history(page)).toEqual(current);
  await page.evaluate(() =>
    Object.assign(window, {
      showSaveFilePicker: async () => ({
        getFile: async () => new File([], "unused.wav"),
        createWritable: async () => ({
          write: async () => {
            throw new Error("disk full");
          },
          close: async () => {},
          abort: async () => {},
        }),
      }),
    }),
  );
  await save(page);
  await expect(page.getByText("Could not save audio", { exact: true })).toBeVisible();
  expect(await history(page)).toEqual(current);
  await page
    .getByTestId("audio-file-input")
    .setInputFiles({ name: "broken.wav", mimeType: "audio/wav", buffer: Buffer.from("invalid") });
  await expect(page.getByText("Could not open audio", { exact: true })).toBeVisible();
  expect(await history(page)).toEqual(current);
  await load(page);
  const opened = await history(page);
  expect(opened.entries).toHaveLength(1);
  expect(opened.dirty).toBe(false);
  expect(opened.canUndo).toBe(false);
  expect(opened.canRedo).toBe(false);
  expect(opened.documentId).not.toBe(current.documentId);
  expect(await samples(page)).toEqual([LEFT, RIGHT]);
});

test("undo and redo stop active playback before publishing restored audio", async ({ page }) => {
  const original = [Array(48_000).fill(0.125), Array(48_000).fill(-0.25)];
  await load(page, original);
  await select(page, 0, 24_000);
  await edit(page, "Mute", 48_000);
  const muted = await samples(page);
  await page.getByLabel("Loop", { exact: true }).check();
  for (const [shortcut, expected] of [
    ["Control+z", original],
    ["Control+Shift+z", muted],
  ] as const) {
    await page.getByTestId("play").click();
    await expect
      .poll(async () => Number(await page.getByTestId("frames-played").textContent()))
      .toBeGreaterThan(0);
    await navigate(page, () => page.keyboard.press(shortcut));
    await expect(page.getByTestId("stop")).toBeDisabled();
    await expect(page.getByTestId("play")).toBeEnabled();
    expect(await samples(page)).toEqual(expected);
  }
});

test("converted paste is one undoable edit and redo preserves its exact converted samples", async ({
  page,
}) => {
  await load(page, [Array(48_000).fill(0.125)]);
  await select(page, 0, 48_000);
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect.poll(async () => (await clipboard(page)).frames).toBe(48_000);
  const copied = await clipboard(page);
  const original = [Array(24_000).fill(0.25)];
  await load(page, original, 24_000);
  await page.getByRole("button", { name: "Paste", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Convert clipboard", exact: true })
    .getByRole("button", { name: "Convert and paste", exact: true })
    .click();
  await expect(page.getByTestId("document-details")).toContainText("· 48000 frames");
  const converted = await samples(page);
  expect((await history(page)).entries).toHaveLength(2);
  await navigate(page, () => page.keyboard.press("Control+z"));
  expect(await samples(page)).toEqual(original);
  expect((await history(page)).dirty).toBe(false);
  await navigate(page, () => page.keyboard.press("Control+Shift+z"));
  expect(await samples(page)).toEqual(converted);
  expect(await clipboard(page)).toEqual(copied);
});
