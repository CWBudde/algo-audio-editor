/// <reference lib="dom" />
import type { HistoryListResult, TimelineResult } from "@aae/protocol";
import { type Download, expect, type Page, test } from "@playwright/test";
import { info, LEFT, load, RIGHT, samples, select } from "./edit-fixture.ts";
import { captureKernelWorker } from "./kernel-probe.ts";

async function timeline(page: Page) {
  const document = await info(page);
  return page.evaluate(
    async (documentId) =>
      (await window.__aaeTest?.request("timeline.get", { documentId })) as TimelineResult,
    document.documentId,
  );
}

async function history(page: Page) {
  const document = await info(page);
  return page.evaluate(
    async (documentId) =>
      (await window.__aaeTest?.request("history.list", { documentId })) as HistoryListResult,
    document.documentId,
  );
}

async function downloadBytes(download: Download) {
  const stream = await download.createReadStream();
  if (!stream) throw new Error("download stream missing");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function add(page: Page, kind: "marker" | "region", name: string, color: string) {
  await page.getByLabel("Marker or region name").fill(name);
  await page.getByLabel("Marker or region color").fill(color);
  await page.getByRole("button", { name: `Add ${kind}`, exact: true }).click();
  await expect
    .poll(async () =>
      (await timeline(page))[kind === "marker" ? "markers" : "regions"].some(
        (anchor) => anchor.name === name,
      ),
    )
    .toBe(true);
}

test.beforeEach(async ({ page }) => {
  await captureKernelWorker(page);
  await page.addInitScript(() => Object.assign(window, { showSaveFilePicker: undefined }));
  await page.goto("/");
  await expect(page.getByTestId("kernel-status")).toHaveText("kernel ready");
});

test("timeline management, sidecars and saved WAV preserve names, colors and IDs", async ({
  page,
}) => {
  await load(page);
  const originalInfo = await info(page);
  await select(page, 2, 6);
  await add(page, "region", "Verse", "#123456");
  await add(page, "marker", 'Cue, "é"', "#abcdef");
  expect(await info(page)).toEqual(originalInfo);
  expect((await history(page)).entries).toHaveLength(3);
  await expect(page.getByTestId("history-dirty")).toHaveText("Unsaved changes");
  await page.locator("summary").filter({ hasText: "Markers and regions (2)" }).click();
  await page.getByRole("button", { name: 'Edit marker Cue, "é"', exact: true }).click();
  await page.getByLabel("Timeline name", { exact: true }).fill("Renamed 🎵");
  await page.getByLabel("Timeline color", { exact: true }).fill("#fedcba");
  await page.getByLabel("Marker position", { exact: true }).fill("8");
  await page.getByRole("button", { name: "Save marker", exact: true }).click();
  await expect(page.getByTestId("marker-row-2")).toContainText("Renamed 🎵");
  await page.getByRole("button", { name: "Jump to marker Renamed 🎵", exact: true }).click();
  await expect(page.getByLabel("Selection start", { exact: true })).toHaveValue("8");
  await expect(page.getByLabel("Selection end", { exact: true })).toHaveValue("8");
  await page.getByRole("button", { name: "Jump to region Verse", exact: true }).click();
  await expect(page.getByLabel("Selection start", { exact: true })).toHaveValue("2");
  await expect(page.getByLabel("Selection end", { exact: true })).toHaveValue("6");
  const expected = await timeline(page);
  const dirtyHistory = await history(page);
  for (const [button, suffix] of [
    ["Export CSV", ".markers.csv"],
    ["Export labels", ".labels.txt"],
  ] as const) {
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: button, exact: true }).click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe(`edit-48000${suffix}`);
    const content = (await downloadBytes(download)).toString("utf8");
    expect(content).toContain("Verse");
    expect(content).toContain("Renamed 🎵");
    if (button === "Export CSV")
      expect(content).toContain(
        "kind,id,name,color,start_frame,end_frame,start_seconds,end_seconds",
      );
    else expect(content).toContain("0.000041667\t0.000125000\tVerse\n");
    expect(await history(page)).toEqual(dirtyHistory);
  }
  const pending = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Save\b/ }).click();
  const saved = await downloadBytes(await pending);
  expect(saved.includes(Buffer.from("cue "))).toBe(true);
  expect(saved.includes(Buffer.from("adtl"))).toBe(true);
  expect(saved.includes(Buffer.from("labl"))).toBe(true);
  expect(saved.includes(Buffer.from("ltxt"))).toBe(true);
  expect(saved.readUInt32LE(4)).toBe(saved.length - 8);
  await expect(page.getByTestId("history-dirty")).toHaveText("Saved");
  await page
    .getByTestId("audio-file-input")
    .setInputFiles({ name: "roundtrip.wav", mimeType: "audio/wav", buffer: saved });
  await expect.poll(async () => (await info(page)).documentId).not.toBe(originalInfo.documentId);
  await expect(page.getByLabel("Selection start", { exact: true })).toBeEnabled();
  const reopened = await timeline(page);
  expect(reopened.markers).toEqual(expected.markers);
  expect(reopened.regions).toEqual(expected.regions);
  expect(await samples(page)).toEqual([LEFT, RIGHT]);
  expect((await history(page)).entries).toHaveLength(1);
  expect((await history(page)).dirty).toBe(false);
  const remove = page.getByRole("button", { name: "Delete marker Renamed 🎵", exact: true });
  if (!(await remove.isVisible()))
    await page.locator("summary").filter({ hasText: "Markers and regions (2)" }).click();
  await remove.click();
  await expect(page.getByTestId("marker-row-2")).toHaveCount(0);
  const docId = (await info(page)).documentId;
  await page.locator("aside[aria-label='Edit history'] summary").click();
  await page.getByRole("button", { name: "Undo edit", exact: true }).click();
  await expect.poll(async () => (await info(page)).documentId).not.toBe(docId);
  expect((await timeline(page)).markers).toEqual(expected.markers);
  expect((await history(page)).dirty).toBe(false);
});

test("metadata mutation keeps real playback, document identity, peaks and zoom", async ({
  page,
}) => {
  await load(page, [Array(48_000).fill(0.125), Array(48_000).fill(-0.25)]);
  await select(page, 4_000, 8_000);
  await page.getByRole("button", { name: "Zoom to selection", exact: true }).click();
  await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-start-frame", "4000");
  await page.getByLabel("Loop", { exact: true }).check();
  await page.getByLabel("Follow playback", { exact: true }).selectOption("off");
  await page.getByTestId("play").click();
  await expect
    .poll(async () => Number(await page.getByTestId("frames-played").textContent()))
    .toBeGreaterThan(256);
  const before = await info(page);
  const peakCalls = await page.evaluate(() => window.__aaeTest?.peakCalls.length);
  const played = Number(await page.getByTestId("frames-played").textContent());
  await add(page, "marker", "Live cue", "#112233");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
  await expect
    .poll(async () => Number(await page.getByTestId("frames-played").textContent()))
    .toBeGreaterThan(played);
  expect(await info(page)).toEqual(before);
  expect(await page.evaluate(() => window.__aaeTest?.peakCalls.length)).toBe(peakCalls);
  await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-start-frame", "4000");
  await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-end-frame", "8000");
  await expect(page.getByTestId("history-dirty")).toHaveText("Unsaved changes");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
});
