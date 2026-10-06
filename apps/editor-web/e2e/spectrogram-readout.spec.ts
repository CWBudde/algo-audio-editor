/// <reference lib="dom" />
import { writeFile } from "node:fs/promises";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { runCommand } from "./command-fixture.ts";
import { load, samples } from "./edit-fixture.ts";
import { sourceState } from "./export-fixture.ts";
import { captureKernelWorker } from "./kernel-probe.ts";

const RATE = 44100;
const NYQUIST = RATE / 2;
const SOURCE = Array.from({ length: 8192 }, (_, frame) => (frame % 16 < 8 ? 0.25 : -0.25));

async function completed(canvas: Locator) {
  await expect
    .poll(() =>
      canvas.evaluate((element) => {
        const total = Number(element.getAttribute("data-total-tiles"));
        return total > 0 && total === Number(element.getAttribute("data-completed-tiles"));
      }),
    )
    .toBe(true);
}

async function bounds(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Spectrogram geometry missing");
  return box;
}

async function pixels(canvas: Locator) {
  return canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
}

// Record the actual native pointer coordinates: Chromium may quantize CSS
// coordinates independently of backing-store pixels. This remains a physical
// browser interaction rather than a synthetic React event or kernel shortcut.
async function pointAt(page: Page, surface: Locator, x: number, y: number) {
  await surface.evaluate((element) => {
    const target = window as Window & { __spectrogramPointer?: { x: number; y: number } };
    target.__spectrogramPointer = undefined;
    element.addEventListener(
      "pointermove",
      (event) => {
        const pointer = event as PointerEvent;
        target.__spectrogramPointer = { x: pointer.clientX, y: pointer.clientY };
      },
      { capture: true, once: true },
    );
  });
  const box = await bounds(surface);
  await page.mouse.move(box.x + box.width * x, box.y + box.height * y);
  const point = await page.evaluate(
    () =>
      (window as Window & { __spectrogramPointer?: { x: number; y: number } }).__spectrogramPointer,
  );
  if (!point) {
    const layout = await page.evaluate(() => {
      const lanes = document.querySelector("[data-testid=waveform-lanes]");
      const main = document.querySelector("main");
      const geometry = (element: Element | null) =>
        element
          ? {
              height: element.getBoundingClientRect().height,
              clientHeight: element.clientHeight,
              scrollHeight: element.scrollHeight,
              overflow: getComputedStyle(element).overflow,
            }
          : undefined;
      return { lanes: geometry(lanes), main: geometry(main) };
    });
    throw new Error(`Native spectrogram pointer event missing: ${JSON.stringify(layout)}`);
  }
  return { point, box };
}

async function correctReadout(page: Page, canvas: Locator, surface: Locator, channel: number) {
  await surface.scrollIntoViewIfNeeded();
  const readout = page.getByTestId(`spectrogram-readout-${channel}`);
  await expect(readout).toBeEnabled();
  for (const [x, y] of [
    [0.25, 0.25],
    [0.5, 0.5],
  ]) {
    const { point, box } = await pointAt(page, surface, x, y);
    const start = Number(await canvas.getAttribute("data-start-frame"));
    const end = Number(await canvas.getAttribute("data-end-frame"));
    const seconds = (start + ((point.x - box.x) / box.width) * (end - start)) / RATE;
    const hz = (1 - (point.y - box.y) / box.height) * NYQUIST;
    await expect
      .poll(async () => {
        const text = await readout.inputValue();
        const time = /([\d.]+)\s*s\b/.exec(text);
        const frequency = /([\d.]+)\s*(k?Hz)\b/.exec(text);
        if (!time || !frequency) return false;
        const shownHz = Number(frequency[1]) * (frequency[2] === "kHz" ? 1000 : 1);
        return Math.abs(Number(time[1]) - seconds) <= 0.000001 && Math.abs(shownHz - hz) <= 1;
      })
      .toBe(true);
  }
  return readout;
}

async function rulerMatchesImage(page: Page, channel: number) {
  const canvas = page.getByTestId(`spectrogram-canvas-${channel}`);
  const ruler = page.getByTestId(`spectrogram-frequency-ruler-${channel}`);
  await expect(ruler).toHaveAttribute("data-scale", "linear");
  await expect(ruler).toHaveAttribute("data-nyquist-hz", String(NYQUIST));
  const image = await bounds(canvas);
  const scale = await bounds(ruler);
  expect(Math.abs(scale.y - image.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(scale.height - image.height)).toBeLessThanOrEqual(1);
  const ticks = ruler.locator("[data-frequency-hz]");
  expect(await ticks.count()).toBeGreaterThanOrEqual(3);
  const values: number[] = [];
  for (const tick of await ticks.all()) {
    const hz = Number(await tick.getAttribute("data-frequency-hz"));
    values.push(hz);
    const label = ((await tick.textContent()) ?? "").replaceAll(/\s+/g, " ");
    const number = /([\d.]+)\s*(k?Hz)/.exec(label);
    if (!number) throw new Error(`Frequency ruler unit missing: ${label}`);
    const shownHz = Number(number[1]) * (number[2] === "kHz" ? 1000 : 1);
    expect(Math.abs(shownHz - hz)).toBeLessThanOrEqual(1);
    const position = await bounds(tick);
    const expectedY = image.y + (1 - hz / NYQUIST) * image.height;
    // Endpoint text stays inside the image; interior labels center on their
    // frequency coordinate. Allow its small font's half-height at the ends.
    expect(Math.abs(position.y + position.height / 2 - expectedY)).toBeLessThanOrEqual(10);
  }
  expect(Math.max(...values)).toBe(NYQUIST);
  expect(Math.min(...values)).toBe(0);
  expect(values.some((hz) => hz > 0 && hz < NYQUIST)).toBe(true);
  const footer = page.getByTestId(`spectrogram-footer-${channel}`);
  const status = await bounds(footer);
  expect(status.y).toBeGreaterThanOrEqual(image.y + image.height - 1);
  expect(status.height).toBeGreaterThanOrEqual(24);
  expect(
    await footer.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  return { canvas, ruler, footer };
}

for (const dpr of [1, 2]) {
  test.describe(`spectrogram coordinates at DPR ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr, viewport: { width: 1280, height: 900 } });
    test("frequency ticks and pointer time follow the real image and zoomed viewport", async ({
      page,
    }, testInfo) => {
      await captureKernelWorker(page);
      await page.goto("/");
      await expect(page.locator("[data-kernel-state]")).toHaveAttribute(
        "data-kernel-state",
        "ready",
      );
      await load(page, [SOURCE], RATE);
      const before = await sourceState(page);
      await runCommand(page, "view.spectrogram", "View");
      const { canvas, footer } = await rulerMatchesImage(page, 0);
      await completed(canvas);
      await expect(page.getByTestId("waveform-amplitude-ruler-0")).toHaveCount(0);
      const image = await pixels(canvas);
      const identity = await canvas.getAttribute("data-history-state");
      expect(identity).toBeTruthy();
      const readout = await correctReadout(page, canvas, canvas, 0);
      await readout.focus();
      await expect(readout).toBeFocused();
      await expect(readout).toBeInViewport();
      expect(await pixels(canvas)).toBe(image);
      await page.screenshot({ path: testInfo.outputPath(`spectral-pointer-dpr-${dpr}.png`) });
      await page.mouse.move(0, 0);
      await expect(readout).not.toHaveValue(/\d\.\d+\s*s\b/);

      const end = await canvas.getAttribute("data-end-frame");
      await page.getByRole("button", { name: "Zoom in", exact: true }).click();
      await expect(canvas).not.toHaveAttribute("data-end-frame", end ?? "0");
      await completed(canvas);
      await rulerMatchesImage(page, 0);
      await correctReadout(page, canvas, canvas, 0);
      await expect(canvas).toHaveAttribute("data-history-state", identity ?? "");
      await expect(footer).toBeInViewport();
      expect(await sourceState(page)).toEqual(before);
      expect(await samples(page)).toEqual([SOURCE]);
    });
  });
}

test("narrow split channels keep separate rulers, footer access and rectangle image geometry", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 480, height: 720 });
  await captureKernelWorker(page);
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
  await load(page, [SOURCE, SOURCE, SOURCE, SOURCE], RATE);
  const before = await sourceState(page);
  await runCommand(page, "view.split-spectral", "View");
  const canvas = page.getByTestId("spectrogram-canvas-3");
  await completed(canvas);
  await canvas.scrollIntoViewIfNeeded();
  const { footer } = await rulerMatchesImage(page, 3);
  await footer.scrollIntoViewIfNeeded();
  const amplitude = await bounds(page.getByTestId("waveform-amplitude-ruler-3"));
  const waveform = await bounds(page.getByTestId("waveform-channel-3"));
  const frequency = await bounds(page.getByTestId("spectrogram-frequency-ruler-3"));
  const image = await bounds(canvas);
  expect(Math.abs(amplitude.y - waveform.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(amplitude.height - waveform.height)).toBeLessThanOrEqual(1);
  expect(amplitude.y + amplitude.height).toBeLessThanOrEqual(frequency.y + 1);
  expect(image.height).toBe(waveform.height);
  await page.getByLabel("Spectrogram selection tool", { exact: true }).selectOption("rectangle");
  const layer = page.getByTestId("spectral-selection-3");
  await expect(
    page.getByRole("group", { name: "Channel 4 waveform editor", exact: true }),
  ).not.toHaveAttribute("aria-disabled", "true");
  await expect(layer).toBeEnabled();
  const overlay = await bounds(layer);
  expect(Math.abs(overlay.y - image.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(overlay.height - image.height)).toBeLessThanOrEqual(1);
  const raster = await pixels(canvas);
  const identity = await canvas.getAttribute("data-history-state");
  await correctReadout(page, canvas, layer, 3);
  const start = Number(await canvas.getAttribute("data-start-frame"));
  const end = Number(await canvas.getAttribute("data-end-frame"));
  const from = await pointAt(page, layer, 0.25, 0.25);
  await page.mouse.down();
  const to = await pointAt(page, layer, 0.75, 0.75);
  await page.mouse.up();
  const frameAt = (x: number) => start + ((x - overlay.x) / overlay.width) * (end - start);
  await expect(layer).toHaveAttribute(
    "data-start-frame",
    String(Math.floor(frameAt(from.point.x))),
  );
  await expect(layer).toHaveAttribute("data-end-frame", String(Math.ceil(frameAt(to.point.x))));
  const low = (1 - (to.point.y - overlay.y) / overlay.height) * NYQUIST;
  const high = (1 - (from.point.y - overlay.y) / overlay.height) * NYQUIST;
  expect(Number(await layer.getAttribute("data-low-hz"))).toBeCloseTo(low, 5);
  expect(Number(await layer.getAttribute("data-high-hz"))).toBeCloseTo(high, 5);
  expect(await pixels(canvas)).toBe(raster);
  await expect(canvas).toHaveAttribute("data-history-state", identity ?? "");
  await page.screenshot({ path: testInfo.outputPath("split-pointer-rectangle-narrow.png") });
  await page.setViewportSize({ width: 320, height: 640 });
  await completed(canvas);
  const lanes = page.getByTestId("waveform-lanes");
  await expect
    .poll(() => lanes.evaluate((element) => element.clientHeight))
    .toBeGreaterThanOrEqual(128);
  await rulerMatchesImage(page, 3);
  await footer.scrollIntoViewIfNeeded();
  await correctReadout(page, canvas, layer, 3);
  await footer.scrollIntoViewIfNeeded();
  const readout = page.getByTestId("spectrogram-readout-3");
  await readout.focus();
  await expect(readout).toBeInViewport({ ratio: 1 });
  await expect(footer).toBeInViewport({ ratio: 1 });
  expect(
    await readout.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.screenshot({ path: testInfo.outputPath("dense-footer-narrow.png") });
  const layout = await page.evaluate(() => {
    const lanes = document.querySelector("[data-testid=waveform-lanes]");
    const main = document.querySelector("main");
    const footer = document.querySelector("[data-testid=spectrogram-footer-3]");
    return {
      laneHeight: lanes?.clientHeight,
      laneScrollHeight: lanes?.scrollHeight,
      mainHeight: main?.clientHeight,
      mainScrollHeight: main?.scrollHeight,
      footerHeight: footer?.getBoundingClientRect().height,
    };
  });
  const layoutPath = testInfo.outputPath("narrow-layout.json");
  await writeFile(layoutPath, JSON.stringify(layout, null, 2));
  await testInfo.attach("narrow-spectrogram-layout", {
    path: layoutPath,
    contentType: "application/json",
  });
  expect(await sourceState(page)).toEqual(before);
  expect(await samples(page)).toEqual([SOURCE, SOURCE, SOURCE, SOURCE]);
});
