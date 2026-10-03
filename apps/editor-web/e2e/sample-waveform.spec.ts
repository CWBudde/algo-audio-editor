/// <reference lib="dom" />

import type { DocumentInfoResult, HistoryListResult } from "@aae/protocol";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { info, load, samples, select } from "./edit-fixture.ts";
import { captureKernelWorker } from "./kernel-probe.ts";
import { revealControl } from "./ui-disclosures.ts";

// Independent IEEE-float WAV payload: exact binary fractions, both signs,
// a horizontal pair that distinguishes a dot from a one-pixel connection,
// and unequal neighboring values that distinguish linear from hold geometry.
const LEFT = [-0.75, 0.75, -0.5, 0.5, 0.5, 0, -0.25, 0.75];
const RIGHT = [0.75, -0.75, 0.5, -0.5, -0.5, 0, 0.25, -0.75];
const SOURCE = [LEFT, RIGHT];

interface PixelPoint {
  frame: number;
  amplitude: number;
  offsetY?: number;
  // Zero checks one physical pixel (used for the off-line body of a dot).
  radius?: number;
}

/** Inspect actual production canvas pixels against its resolved CSS roles.
 * This is a test-only geometry oracle, not a sample reconstruction/DSP path. */
async function paintPixels(canvas: Locator, points: PixelPoint[]) {
  return canvas.evaluate((element, positions) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas context missing");
    const bounds = canvas.getBoundingClientRect();
    const viewport = canvas.closest("[data-start-frame]");
    if (!viewport) throw new Error("waveform viewport missing");
    const start = Number(viewport.getAttribute("data-start-frame"));
    const end = Number(viewport.getAttribute("data-end-frame"));
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const swatch = document.createElement("canvas");
    swatch.width = swatch.height = 1;
    const swatchContext = swatch.getContext("2d");
    if (!swatchContext) throw new Error("color context missing");
    const color = (property: string) => {
      const value = getComputedStyle(canvas).getPropertyValue(property).trim();
      if (!value) throw new Error(`CSS role ${property} missing`);
      swatchContext.clearRect(0, 0, 1, 1);
      swatchContext.fillStyle = value;
      swatchContext.fillRect(0, 0, 1, 1);
      return Array.from(swatchContext.getImageData(0, 0, 1, 1).data).slice(0, 3);
    };
    const peak = color("--editor-waveform-peak");
    const dot = color("--editor-waveform-sample");
    const rms = color("--editor-waveform-rms");
    const background = color("--editor-waveform-background");
    function matches(offset: number, expected: number[]) {
      // A one-CSS-pixel stroke on an integer raster boundary can occupy two
      // partially covered rows at DPR 1. Recognize the actual role/background
      // blend, not only fully opaque paint. Blank background and other roles
      // still fail the minimum coverage and tight independent RGB residual.
      const delta = expected.map((value, channel) => value - background[channel]);
      const denominator = delta.reduce((sum, value) => sum + value * value, 0);
      if (denominator === 0) return false;
      const coverage =
        delta.reduce(
          (sum, value, channel) => sum + value * (pixels[offset + channel] - background[channel]),
          0,
        ) / denominator;
      return (
        coverage >= 0.2 &&
        coverage <= 1.05 &&
        expected.every(
          (_, channel) =>
            Math.abs(
              pixels[offset + channel] - (background[channel] + coverage * delta[channel]),
            ) <= 5,
        )
      );
    }
    let rmsPixels = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (matches(offset, rms)) rmsPixels++;
    }
    return {
      width: canvas.width,
      height: canvas.height,
      cssWidth: bounds.width,
      cssHeight: bounds.height,
      dpr: window.devicePixelRatio,
      rmsPixels,
      points: positions.map(({ frame, amplitude, offsetY = 0, radius = 1 }) => {
        const x = ((frame - start) / (end - start)) * bounds.width;
        const y = ((1 - amplitude) / 2) * bounds.height + offsetY;
        const scaleX = canvas.width / bounds.width;
        const scaleY = canvas.height / bounds.height;
        const centerX = Math.floor(x * scaleX);
        const centerY = Math.floor(y * scaleY);
        const radiusX = Math.ceil(radius * scaleX);
        const radiusY = Math.ceil(radius * scaleY);
        let painted = false;
        for (
          let py = Math.max(0, centerY - radiusY);
          py <= Math.min(canvas.height - 1, centerY + radiusY);
          py++
        ) {
          for (
            let px = Math.max(0, centerX - radiusX);
            px <= Math.min(canvas.width - 1, centerX + radiusX);
            px++
          ) {
            const offset = (py * canvas.width + px) * 4;
            if (matches(offset, peak) || matches(offset, dot)) painted = true;
          }
        }
        return painted;
      }),
    };
  }, points);
}

async function painted(page: Page, mode: "envelope" | "linear" | "steps") {
  for (const channel of [0, 1]) {
    await expect(page.getByTestId(`waveform-channel-${channel}`)).toHaveAttribute(
      "data-display-mode",
      mode,
    );
    await expect(page.getByTestId(`waveform-channel-${channel}`)).toHaveAttribute(
      "data-rendered",
      "true",
    );
  }
  await expect(page.getByTestId("waveform-overview")).toHaveAttribute(
    "data-display-mode",
    "envelope",
  );
  await expect(page.getByTestId("waveform-overview")).toHaveAttribute("data-rendered", "true");
}

async function history(page: Page) {
  return page.evaluate(async () => {
    const document = (await window.__aaeTest?.request("doc.info")) as DocumentInfoResult;
    return (await window.__aaeTest?.request("history.list", {
      documentId: document.documentId,
    })) as HistoryListResult;
  });
}

async function peakCalls(page: Page) {
  return page.evaluate(() => window.__aaeTest?.peakCalls ?? []);
}

async function start(page: Page) {
  await captureKernelWorker(page);
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
  await load(page, SOURCE);
  // The shared helper closes the settings disclosure after choosing samples.
  await expect(page.getByTestId("view-settings")).not.toHaveAttribute("open", "");
  await painted(page, "linear");
}

for (const dpr of [1, 2]) {
  test.describe(`actual sample canvas at DPR ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr, viewport: { width: 1280, height: 900 } });

    test("signed dots and linear/steps paths reuse kernel data without changing the document", async ({
      page,
    }, testInfo) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await start(page);
      if (dpr === 1)
        await page.screenshot({ path: testInfo.outputPath("editor-sample-detail.png") });
      const beforeInfo = await info(page);
      const beforeHistory = await history(page);
      expect(beforeHistory.dirty).toBe(false);
      expect(await samples(page)).toEqual(SOURCE);
      const beforeCalls = await peakCalls(page);
      for (const channel of [0, 1]) {
        expect(
          beforeCalls.some(
            (call) =>
              call.channel === channel &&
              call.startFrame === 0 &&
              call.endFrame === 8 &&
              call.buckets === 8,
          ),
        ).toBe(true);
        const values = SOURCE[channel];
        const actual = await paintPixels(page.getByTestId(`waveform-channel-${channel}`), [
          ...[1, 2, 3, 4, 6, 7].map((frame) => ({ frame, amplitude: values[frame] })),
          { frame: 2, amplitude: -values[2] },
          { frame: 3, amplitude: values[3], offsetY: 1.5, radius: 0 },
          { frame: 2.5, amplitude: 0 },
          { frame: 2.5, amplitude: values[2] },
          { frame: 7.5, amplitude: values[7] },
        ]);
        expect(actual.width).toBe(Math.round(actual.cssWidth * dpr));
        expect(actual.height).toBe(Math.round(actual.cssHeight * dpr));
        expect(actual.points).toEqual([
          true,
          true,
          true,
          true,
          true,
          true,
          false,
          true,
          true,
          false,
          false,
        ]);
        expect(actual.rmsPixels).toBe(0);
      }
      await (await revealControl(page.getByLabel("Sample display", { exact: true }))).selectOption(
        "steps",
      );
      await painted(page, "steps");
      for (const channel of [0, 1]) {
        const values = SOURCE[channel];
        const actual = await paintPixels(page.getByTestId(`waveform-channel-${channel}`), [
          { frame: 2.5, amplitude: 0 },
          { frame: 2.5, amplitude: values[2] },
          { frame: 7.5, amplitude: values[7] },
        ]);
        expect(actual.points).toEqual([false, true, true]);
        expect(actual.rmsPixels).toBe(0);
      }
      await page.getByLabel("Sample display", { exact: true }).selectOption("linear");
      await painted(page, "linear");
      expect(await peakCalls(page)).toEqual(beforeCalls);
      expect(await samples(page)).toEqual(SOURCE);
      expect(await info(page)).toEqual(beforeInfo);
      expect(await history(page)).toEqual(beforeHistory);
      expect(errors).toEqual([]);
    });

    test("the threshold is strictly above one CSS pixel per sample, not one backing pixel", async ({
      page,
    }) => {
      await start(page);
      const canvas = page.getByTestId("waveform-channel-0");
      const cssWidth = await canvas.evaluate((element) =>
        Number.parseFloat((element as HTMLCanvasElement).style.width),
      );
      expect(Number.isInteger(cssWidth)).toBe(true);
      const values = Array.from({ length: cssWidth }, (_, frame) => (frame % 2 === 0 ? -0.5 : 0.5));
      await load(page, [values, values]);
      await painted(page, "envelope");
      expect(
        await canvas.evaluate((element) =>
          Number.parseFloat((element as HTMLCanvasElement).style.width),
        ),
      ).toBe(values.length);
      await page.setViewportSize({ width: 1284, height: 900 });
      await expect
        .poll(async () =>
          canvas.evaluate((element) =>
            Number.parseFloat((element as HTMLCanvasElement).style.width),
          ),
        )
        .toBeGreaterThan(values.length);
      await painted(page, "linear");
      const calls = await peakCalls(page);
      for (const channel of [0, 1]) {
        expect(
          calls.some(
            (call) =>
              call.channel === channel &&
              call.startFrame === 0 &&
              call.endFrame === values.length &&
              call.buckets === values.length,
          ),
        ).toBe(true);
      }
      const actual = await paintPixels(canvas, []);
      expect(actual.width).toBe(Math.round(actual.cssWidth * dpr));
      expect(actual.rmsPixels).toBe(0);
    });
  });
}

test("zoomed detail includes one true neighbor and clips at the viewport and document EOF", async ({
  page,
}) => {
  await start(page);
  await select(page, 6, 8);
  await page.getByRole("button", { name: "Zoom to selection", exact: true }).click();
  await painted(page, "linear");
  const canvas = page.getByTestId("waveform-channel-0");
  await expect(canvas).toHaveAttribute("data-sample-start", "5");
  await expect(canvas).toHaveAttribute("data-sample-end", "8");
  const calls = await peakCalls(page);
  for (const channel of [0, 1]) {
    expect(
      calls.some(
        (call) =>
          call.channel === channel &&
          call.startFrame === 5 &&
          call.endFrame === 8 &&
          call.buckets === 3,
      ),
    ).toBe(true);
  }
  expect(
    (
      await paintPixels(canvas, [
        { frame: 6, amplitude: LEFT[6] },
        { frame: 6.5, amplitude: 0.25 },
        { frame: 7, amplitude: LEFT[7] },
        { frame: 7.5, amplitude: LEFT[7] },
      ])
    ).points,
  ).toEqual([true, true, true, false]);
  expect(await samples(page)).toEqual(SOURCE);
  expect((await history(page)).dirty).toBe(false);
});
