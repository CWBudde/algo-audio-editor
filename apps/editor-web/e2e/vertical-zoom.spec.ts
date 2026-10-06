/// <reference lib="dom" />
import { expect, type Locator, test } from "@playwright/test";
import { runCommand } from "./command-fixture.ts";
import { load, samples } from "./edit-fixture.ts";
import { sourceState } from "./export-fixture.ts";
import { captureKernelWorker } from "./kernel-probe.ts";
import { revealControl } from "./ui-disclosures.ts";

async function colorsAt(canvas: Locator, x: number, y: number) {
  return canvas.evaluate(
    (element, point) => {
      const canvas = element as HTMLCanvasElement;
      const context = canvas.getContext("2d");
      const swatch = document.createElement("canvas").getContext("2d");
      if (!context || !swatch) throw new Error("canvas contexts missing");
      const role = (property: string) => {
        swatch.clearRect(0, 0, 1, 1);
        swatch.fillStyle = getComputedStyle(canvas).getPropertyValue(property).trim();
        swatch.fillRect(0, 0, 1, 1);
        return Array.from(swatch.getImageData(0, 0, 1, 1).data);
      };
      const px = Math.floor(canvas.width * point.x);
      const py = Math.floor(canvas.height * point.y);
      const actual = Array.from(context.getImageData(px, py, 1, 1).data);
      const peak = role("--editor-waveform-peak");
      const neighborhood = context.getImageData(
        Math.max(0, px - 3),
        Math.max(0, py - 3),
        7,
        7,
      ).data;
      let peakNearby = false;
      for (let index = 0; index < neighborhood.length; index += 4)
        if (peak.every((value, channel) => Math.abs(neighborhood[index + channel] - value) <= 2))
          peakNearby = true;
      return {
        actual,
        peakNearby,
        background: role("--editor-waveform-background"),
        rms: role("--editor-waveform-rms"),
      };
    },
    { x, y },
  );
}

test("split-view zoom preserves spectral pixels and frequency rulers do not zoom amplitude", async ({
  page,
}) => {
  await captureKernelWorker(page);
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
  const channel = Array.from({ length: 24000 }, (_, frame) => (frame % 16 < 8 ? 0.125 : -0.125));
  await load(page, [channel, channel]);
  await runCommand(page, "view.split-spectral", "View");
  const spectral = page.getByTestId("spectrogram-canvas-0");
  await expect
    .poll(async () => {
      const total = Number(await spectral.getAttribute("data-total-tiles"));
      return total > 0 && total === Number(await spectral.getAttribute("data-completed-tiles"));
    })
    .toBe(true);
  const before = await sourceState(page);
  const pixels = await spectral.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
  const zoom = await revealControl(page.getByLabel("Vertical zoom", { exact: true }));
  await zoom.selectOption("4");
  await zoom.press("Escape");
  await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-vertical-zoom", "4");
  expect(await spectral.evaluate((element) => (element as HTMLCanvasElement).toDataURL())).toBe(
    pixels,
  );
  expect(await sourceState(page)).toEqual(before);
  await runCommand(page, "view.spectrogram", "View");
  const ruler = page.getByTestId("waveform-amplitude-ruler-0");
  await expect(ruler.getByText("24000 Hz", { exact: true })).toBeVisible();
  const bounds = await ruler.boundingBox();
  if (!bounds) throw new Error("frequency ruler missing");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, -120);
  await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-vertical-zoom", "4");
  expect(await sourceState(page)).toEqual(before);
});

for (const dpr of [1, 2]) {
  test.describe(`vertical waveform zoom at DPR ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr, viewport: { width: 1280, height: 900 } });

    test.beforeEach(async ({ page }) => {
      await captureKernelWorker(page);
      await page.goto("/");
      await expect(page.locator("[data-kernel-state]")).toHaveAttribute(
        "data-kernel-state",
        "ready",
      );
    });

    test("magnifies quiet envelopes without new peaks, audio edits or overview zoom", async ({
      page,
    }, testInfo) => {
      const channel = Array.from({ length: 96000 }, (_, frame) => (frame % 2 ? 0.125 : -0.125));
      await load(page, [channel, channel]);
      const canvas = page.getByTestId("waveform-channel-0");
      await expect(canvas).toHaveAttribute("data-rendered", "true");
      const before = await sourceState(page);
      const calls = await page.evaluate(() => window.__aaeTest?.peakCalls?.length);
      const overview = page.getByTestId("waveform-overview");
      await expect(overview).toHaveAttribute("data-rendered", "true");
      const overviewPixels = await overview.evaluate((element) =>
        (element as HTMLCanvasElement).toDataURL(),
      );
      // The first bucket starts at x=0 and covers at least one CSS pixel.
      // This physical column is fully painted at either DPR, avoiding fractional
      // interior bucket edges. Repeated raster fills can round one RGB byte
      // at DPR 2; peak-only and blank paint remain far outside that tolerance.
      const initial = await colorsAt(canvas, 0, 0.35);
      expect(initial.actual).toEqual(initial.background);
      const zoom = await revealControl(page.getByLabel("Vertical zoom", { exact: true }));
      await zoom.selectOption("4");
      await zoom.press("Escape");
      await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-vertical-zoom", "4");
      await expect
        .poll(async () => {
          const painted = await colorsAt(canvas, 0, 0.35);
          return painted.actual.every((value, index) => Math.abs(value - painted.rms[index]) <= 1);
        })
        .toBe(true);
      const above = await colorsAt(canvas, 0, 0.2);
      expect(above.actual).toEqual(above.background);
      await expect(
        page.getByTestId("waveform-amplitude-ruler-0").getByText("0.25", { exact: true }),
      ).toBeVisible();
      expect(await overview.evaluate((element) => (element as HTMLCanvasElement).toDataURL())).toBe(
        overviewPixels,
      );
      expect(await page.evaluate(() => window.__aaeTest?.peakCalls?.length)).toBe(calls);
      expect(await sourceState(page)).toEqual(before);
      expect(await samples(page)).toEqual([channel, channel]);
      await page.screenshot({ path: testInfo.outputPath("quiet-waveform-4x.png") });

      const ruler = page.getByTestId("waveform-amplitude-ruler-0");
      const bounds = await ruler.boundingBox();
      if (!bounds) throw new Error("amplitude ruler bounds missing");
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.wheel(0, -120);
      await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-vertical-zoom", "8");
      await ruler.focus();
      await ruler.press("Home");
      await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-vertical-zoom", "1");
      await expect
        .poll(async () => {
          const painted = await colorsAt(canvas, 0, 0.35);
          return painted.actual.every((value, index) => value === painted.background[index]);
        })
        .toBe(true);
      expect(await page.evaluate(() => window.__aaeTest?.peakCalls?.length)).toBe(calls);
      expect(await sourceState(page)).toEqual(before);
    });

    test("sample dots use the same magnification and dB labels reflect actual levels", async ({
      page,
    }) => {
      const left = [-0.125, 0.125, 0, -0.125, 0.25, -0.25, 0.125, 0];
      await load(page, [left, left]);
      const canvas = page.getByTestId("waveform-channel-0");
      await expect(canvas).toHaveAttribute("data-display-mode", "linear");
      await expect(canvas).toHaveAttribute("data-rendered", "true");
      const before = await sourceState(page);
      const calls = await page.evaluate(() => window.__aaeTest?.peakCalls?.length);
      expect((await colorsAt(canvas, 1 / 8, (1 - 0.125) / 2)).peakNearby).toBe(true);
      const zoom = await revealControl(page.getByLabel("Vertical zoom", { exact: true }));
      await zoom.selectOption("4");
      await page.getByLabel("Amplitude scale", { exact: true }).selectOption("db");
      await zoom.press("Escape");
      await expect.poll(async () => (await colorsAt(canvas, 1 / 8, 0.25)).peakNearby).toBe(true);
      expect((await colorsAt(canvas, 3 / 8, 0.75)).peakNearby).toBe(true);
      const dbEdges = page
        .getByTestId("waveform-amplitude-ruler-0")
        .getByText("-12", { exact: true });
      await expect(dbEdges).toHaveCount(2);
      await expect(dbEdges.first()).toBeVisible();
      await expect(dbEdges.last()).toBeVisible();
      expect(await page.evaluate(() => window.__aaeTest?.peakCalls?.length)).toBe(calls);
      expect(await sourceState(page)).toEqual(before);
      expect(await samples(page)).toEqual([left, left]);
      await page.getByTestId("waveform-amplitude-ruler-0").dblclick();
      await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-vertical-zoom", "1");
      await (await revealControl(page.getByLabel("Vertical zoom", { exact: true }))).selectOption(
        "8",
      );
      await page.getByLabel("Vertical zoom", { exact: true }).press("Escape");
      await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-vertical-zoom", "8");
      await load(page, [left, left]);
      await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-vertical-zoom", "1");
    });
  });
}
