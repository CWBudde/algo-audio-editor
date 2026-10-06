/// <reference lib="dom" />

import { expect, type Page, test } from "@playwright/test";
import { analysisCommand } from "./analysis-fixture.ts";
import { sourceState } from "./export-fixture.ts";
import { captureKernelWorker } from "./kernel-probe.ts";
import { playbackWAV } from "./playback-fixture.ts";

async function openWorkspace(page: Page, channels = 2, frames = 24000) {
  await captureKernelWorker(page);
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
  await page.getByTestId("audio-file-input").setInputFiles({
    name: `visual-${channels}-channel.wav`,
    mimeType: "audio/wav",
    buffer: playbackWAV(frames, 48000, channels),
  });
  for (let channel = 0; channel < channels; channel++)
    await expect(page.getByTestId(`waveform-channel-${channel}`)).toHaveAttribute(
      "data-rendered",
      "true",
    );
}

async function assertDocumentFits(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
  await expect(page.locator("footer")).toBeInViewport();
  await page.getByTestId("waveform-overview").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("waveform-overview")).toBeInViewport();
}

for (const channels of [6, 8]) {
  test(`${channels}-channel lanes scroll vertically while the last channel and navigation remain accessible`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await openWorkspace(page, channels);
    const lanes = page.getByTestId("waveform-lanes");
    await expect
      .poll(() => lanes.evaluate((element) => element.scrollHeight > element.clientHeight))
      .toBe(true);
    const first = page.getByTestId("waveform-channel-0");
    const last = page.getByTestId(`waveform-channel-${channels - 1}`);
    expect((await first.boundingBox())?.height).toBeGreaterThanOrEqual(96);
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    expect(await lanes.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await assertDocumentFits(page, 1280);
    await page.screenshot({ path: testInfo.outputPath(`dense-${channels}-channel.png`) });
    const before = await sourceState(page);
    const editor = page.getByRole("group", {
      name: `Channel ${channels} waveform editor`,
      exact: true,
    });
    await editor.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-selection-start", "1");
    await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-selection-end", "1");
    const after = await sourceState(page);
    expect(after.document).toEqual(before.document);
    expect(after.history).toEqual(before.history);
    await page.setViewportSize({ width: 640, height: 720 });
    await expect(last).toHaveAttribute("data-rendered", "true");
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    await assertDocumentFits(page, 640);
    await page.screenshot({ path: testInfo.outputPath(`dense-${channels}-channel-narrow.png`) });
  });
}

test("split lanes retain readable panels, scroll access and spectral selection controls", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openWorkspace(page);
  const before = await sourceState(page);
  await analysisCommand(page, "view.split-spectral", "View");
  const tools = page.getByRole("group", { name: "Spectral editing", exact: true });
  await expect(tools).toBeVisible();
  const spectrogram = page.getByTestId("spectrogram-canvas-1");
  await expect
    .poll(async () => {
      const total = Number(await spectrogram.getAttribute("data-total-tiles"));
      return total > 0 && Number(await spectrogram.getAttribute("data-completed-tiles")) === total;
    })
    .toBe(true);
  const lanes = page.getByTestId("waveform-lanes");
  await expect
    .poll(() => lanes.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);
  await spectrogram.scrollIntoViewIfNeeded();
  await expect(spectrogram).toBeInViewport();
  const waveformHeight = (await page.getByTestId("waveform-channel-1").boundingBox())?.height;
  const spectralHeight = (await spectrogram.boundingBox())?.height;
  expect(waveformHeight).toBeGreaterThanOrEqual(96);
  expect(spectralHeight).toBe(waveformHeight);
  await assertDocumentFits(page, 1280);
  await page.screenshot({ path: testInfo.outputPath("split-lanes-desktop.png") });
  await tools.getByLabel("Spectrogram selection tool", { exact: true }).selectOption("rectangle");
  const layer = page.getByTestId("spectral-selection-1");
  await layer.scrollIntoViewIfNeeded();
  const box = await layer.boundingBox();
  if (!box) throw new Error("spectral selection bounds missing");
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.75, { steps: 4 });
  await page.mouse.up();
  await expect(tools.getByRole("status")).toContainText("Spectral selection: frames");
  await expect(tools.getByRole("button", { name: "Attenuate…", exact: true })).toBeEnabled();
  await tools.getByRole("button", { name: "Clear spectral selection", exact: true }).click();
  await expect(tools.getByRole("status")).toHaveCount(0);
  expect(await sourceState(page)).toEqual(before);
  await page.setViewportSize({ width: 640, height: 720 });
  await spectrogram.scrollIntoViewIfNeeded();
  await expect(spectrogram).toBeInViewport();
  await assertDocumentFits(page, 640);
  await page.screenshot({ path: testInfo.outputPath("split-lanes-narrow.png") });
});

test("combined analysis is side by side on desktop and scrollable on narrow and short screens", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openWorkspace(page, 2, 48000 * 16);
  const before = await sourceState(page);
  await analysisCommand(page, "analyze.spectrum");
  await analysisCommand(page, "analyze.meters");
  const dock = page.getByTestId("analysis-dock");
  const spectrum = page.getByRole("region", { name: "Spectrum analyzer", exact: true });
  const meters = page.getByRole("region", { name: "Playback output meters", exact: true });
  await expect(dock).toBeVisible();
  const spectrumBox = await spectrum.boundingBox();
  const metersBox = await meters.boundingBox();
  if (!spectrumBox || !metersBox) throw new Error("analysis panel bounds missing");
  expect(Math.abs(spectrumBox.y - metersBox.y)).toBeLessThanOrEqual(2);
  expect(spectrumBox.x + spectrumBox.width).toBeLessThanOrEqual(metersBox.x + 1);
  expect((await dock.boundingBox())?.height).toBeLessThanOrEqual(1080 * 0.36 + 2);
  const plot = spectrum.getByRole("img", { name: "Frequency spectrum" });
  const plotWidthDifference = () =>
    plot.evaluate((element) => {
      const svg = element as SVGSVGElement;
      return Math.abs(svg.viewBox.baseVal.width - svg.clientWidth);
    });
  // The scale must follow actual panel width instead of letterboxing a fixed
  // aspect ratio into the middle of a wide analysis surface.
  await expect.poll(plotWidthDifference).toBeLessThanOrEqual(1);
  await spectrum.getByLabel("FFT size", { exact: true }).selectOption("2048");
  await spectrum.getByLabel("Window", { exact: true }).selectOption("blackman");
  await page.getByTestId("play").click();
  await expect(meters.getByRole("meter", { name: "Channel 1 peak" })).toHaveAttribute(
    "aria-valuenow",
    /-6\./,
  );
  await assertDocumentFits(page, 1920);
  await page.screenshot({ path: testInfo.outputPath("analysis-dock-desktop.png") });
  await page.setViewportSize({ width: 640, height: 720 });
  const narrowSpectrum = await spectrum.boundingBox();
  const narrowMeters = await meters.boundingBox();
  if (!narrowSpectrum || !narrowMeters) throw new Error("narrow analysis bounds missing");
  expect(narrowMeters.y).toBeGreaterThanOrEqual(narrowSpectrum.y + narrowSpectrum.height - 1);
  expect((await dock.boundingBox())?.height).toBeLessThanOrEqual(720 * 0.36 + 2);
  await expect.poll(plotWidthDifference).toBeLessThanOrEqual(1);
  const average = spectrum.getByLabel("Averaging", { exact: true });
  await average.scrollIntoViewIfNeeded();
  await expect(average).toBeInViewport();
  await average.selectOption("4");
  const reset = meters.getByRole("button", { name: "Reset holds and loudness", exact: true });
  await reset.scrollIntoViewIfNeeded();
  await expect(reset).toBeInViewport();
  await reset.click();
  await assertDocumentFits(page, 640);
  await page.screenshot({ path: testInfo.outputPath("analysis-dock-narrow.png") });
  await page.setViewportSize({ width: 960, height: 600 });
  await assertDocumentFits(page, 960);
  const closeSpectrum = spectrum.getByRole("button", { name: "Close spectrum", exact: true });
  await closeSpectrum.scrollIntoViewIfNeeded();
  await expect(closeSpectrum).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("analysis-dock-short.png") });
  await closeSpectrum.click();
  const closeMeters = meters.getByRole("button", { name: "Close meters", exact: true });
  await closeMeters.scrollIntoViewIfNeeded();
  await expect(closeMeters).toBeInViewport();
  await closeMeters.click();
  await expect(dock).toHaveCount(0);
  await page.getByTestId("stop").click();
  expect(await sourceState(page)).toEqual(before);
});
