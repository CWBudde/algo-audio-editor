/// <reference lib="dom" />

import { expect, type Page, test } from "@playwright/test";
import { captureKernelWorker } from "./kernel-probe.ts";
import { revealControl } from "./ui-disclosures.ts";

const RATE = 48_000;
const FRAMES = RATE * 20;

/** Independent PCM fixture; each channel has four different signed plateaus. */
function waveformFixture(): Buffer {
  const bytes = Buffer.alloc(44 + FRAMES * 4);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(RATE, 24);
  bytes.writeUInt32LE(RATE * 4, 28);
  bytes.writeUInt16LE(4, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(FRAMES * 4, 40);
  const left = [-24576, -8192, 8192, 24576];
  const right = [16384, 8192, -8192, -16384];
  for (let frame = 0; frame < FRAMES; frame++) {
    const segment = Math.floor((frame * 4) / FRAMES);
    bytes.writeInt16LE(left[segment], 44 + frame * 4);
    bytes.writeInt16LE(right[segment], 46 + frame * 4);
  }
  return bytes;
}

async function openWaveform(page: Page, name = "waveform.wav") {
  await captureKernelWorker(page);
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
  await page.getByTestId("audio-file-input").setInputFiles({
    name,
    mimeType: "audio/wav",
    buffer: waveformFixture(),
  });
  await expect(page.getByTestId("document-name")).toHaveText(name);
  await expect(page.getByTestId("waveform-channel-0")).toHaveAttribute("data-rendered", "true");
  await expect(page.getByTestId("waveform-channel-1")).toHaveAttribute("data-rendered", "true");
}

async function viewport(page: Page) {
  return page.getByTestId("waveform-view").evaluate((element) => ({
    start: Number(element.getAttribute("data-start-frame")),
    end: Number(element.getAttribute("data-end-frame")),
  }));
}

test.describe("high-DPI waveform rendering", () => {
  test.use({ deviceScaleFactor: 2 });

  test("draws both channels and the overview from real transferable kernel peaks", async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openWaveform(page);
    expect(await viewport(page)).toEqual({ start: 0, end: FRAMES });
    for (const channel of [0, 1]) {
      const canvas = page.getByTestId(`waveform-channel-${channel}`);
      const paint = await canvas.evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        const rect = canvas.getBoundingClientRect();
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("canvas context missing");
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let waveformPixels = 0;
        for (let offset = 0; offset < pixels.length; offset += 4) {
          const [r, g, b] = pixels.subarray(offset, offset + 3);
          if (r > 170 && g > 65 && r > g * 1.2 && b < g * 0.8) waveformPixels++;
        }
        return {
          width: canvas.width,
          height: canvas.height,
          cssWidth: rect.width,
          cssHeight: rect.height,
          dpr: window.devicePixelRatio,
          waveformPixels,
        };
      });
      expect(paint.width).toBe(Math.round(paint.cssWidth * paint.dpr));
      expect(paint.height).toBe(Math.round(paint.cssHeight * paint.dpr));
      expect(paint.waveformPixels).toBeGreaterThan(100);
    }
    await expect(page.getByTestId("waveform-overview")).toBeVisible();
    await expect(page.getByTestId("waveform-overview")).toHaveAttribute("data-rendered", "true");
    const rpc = await page.evaluate(() => ({
      calls: window.__aaeTest?.peakCalls,
      replies: window.__aaeTest?.peakReplies,
    }));
    expect(rpc.calls?.some((call) => call.channel === 0 && call.endFrame === FRAMES)).toBe(true);
    expect(rpc.calls?.some((call) => call.channel === 1 && call.endFrame === FRAMES)).toBe(true);
    expect(
      rpc.calls?.filter(
        (call) => call.channel === 0 && call.startFrame === 0 && call.endFrame === FRAMES,
      ),
    ).toHaveLength(1);
    expect(rpc.replies?.length).toBeGreaterThanOrEqual(2);
    for (const result of rpc.replies ?? []) {
      expect(result.isBuffer).toBe(true);
      expect(result.bytes).toBe(result.count * 24);
    }
    const initialWidth = await page
      .getByTestId("waveform-channel-0")
      .evaluate((el) => el.clientWidth);
    await page.setViewportSize({ width: 960, height: 720 });
    await expect
      .poll(async () => page.getByTestId("waveform-channel-0").evaluate((el) => el.clientWidth))
      .not.toBe(initialWidth);
    await expect(page.getByTestId("waveform-channel-0")).toHaveAttribute("data-rendered", "true");
    expect(await viewport(page)).toEqual({ start: 0, end: FRAMES });
    expect(errors).toEqual([]);
    await expect(page.getByTestId("document-memory")).not.toHaveText("0 B");
    await page.screenshot({ path: testInfo.outputPath("waveform.png") });
  });
});

test("anchors wheel zoom at the pointer, scrolls, and exposes menu and shortcut zoom", async ({
  page,
}) => {
  await openWaveform(page);
  const bounds = await page.getByTestId("waveform-channel-0").boundingBox();
  if (!bounds) throw new Error("channel bounds missing");
  const anchor = 0.75;
  // Native wheel coordinates are integer CSS pixels. Observe the actual event
  // rather than treating the fractional mouse target as sample-exact input.
  await page.getByTestId("waveform-channel-0").evaluate((element) => {
    element.addEventListener(
      "wheel",
      (event) => {
        const bounds = element.getBoundingClientRect();
        element.setAttribute(
          "data-test-wheel-anchor",
          String(((event as WheelEvent).clientX - bounds.left) / bounds.width),
        );
      },
      { once: true },
    );
  });
  await page.mouse.move(bounds.x + bounds.width * anchor, bounds.y + bounds.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -320);
  await page.keyboard.up("Control");
  await expect
    .poll(async () => {
      const range = await viewport(page);
      return range.end - range.start;
    })
    .toBeLessThan(FRAMES);
  const zoomed = await viewport(page);
  const eventAnchor = Number(
    await page.getByTestId("waveform-channel-0").getAttribute("data-test-wheel-anchor"),
  );
  expect(Math.abs(eventAnchor - anchor) * bounds.width).toBeLessThanOrEqual(1);
  expect(
    Math.abs(zoomed.start + (zoomed.end - zoomed.start) * eventAnchor - FRAMES * eventAnchor),
  ).toBeLessThanOrEqual(2);
  await page.mouse.wheel(180, 0);
  await expect.poll(async () => (await viewport(page)).start).toBeGreaterThan(zoomed.start);
  const panned = await viewport(page);
  expect(panned.end - panned.start).toBe(zoomed.end - zoomed.start);

  await page.getByRole("menuitem", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Zoom to Fit/ }).click();
  await expect.poll(() => viewport(page)).toEqual({ start: 0, end: FRAMES });
  await page.keyboard.press("Control+=");
  await expect
    .poll(async () => {
      const range = await viewport(page);
      return range.end - range.start;
    })
    .toBeLessThan(FRAMES);
  await page.keyboard.press("Control+0");
  await expect.poll(() => viewport(page)).toEqual({ start: 0, end: FRAMES });
});

test("scrollbar and overview move the viewport, and a dragged selection can be fitted", async ({
  page,
}) => {
  await openWaveform(page);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  const zoomed = await viewport(page);
  const scrollbar = page.getByTestId("waveform-scrollbar");
  await scrollbar.evaluate((element) => {
    element.scrollLeft = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(async () => (await viewport(page)).start).toBe(0);
  const overview = page.getByTestId("waveform-overview-viewport");
  const rectangle = await overview.boundingBox();
  if (!rectangle) throw new Error("overview viewport bounds missing");
  await page.mouse.move(rectangle.x + rectangle.width / 2, rectangle.y + rectangle.height / 2);
  await page.mouse.down();
  await page.mouse.move(rectangle.x + rectangle.width * 0.75, rectangle.y + rectangle.height / 2, {
    steps: 5,
  });
  await page.mouse.up();
  await expect.poll(async () => (await viewport(page)).start).toBeGreaterThan(0);
  const moved = await viewport(page);
  expect(moved.end - moved.start).toBe(zoomed.end - zoomed.start);

  const lane = await page.getByTestId("waveform-channel-0").boundingBox();
  if (!lane) throw new Error("channel bounds missing");
  await page.mouse.move(lane.x + lane.width * 0.2, lane.y + lane.height / 2);
  await page.mouse.down();
  await page.mouse.move(lane.x + lane.width * 0.7, lane.y + lane.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Zoom to selection", exact: true }).click();
  await expect
    .poll(async () => {
      const range = await viewport(page);
      return range.end - range.start;
    })
    .toBeLessThan(moved.end - moved.start);
  const selected = await viewport(page);
  expect(selected.start).toBeGreaterThan(moved.start);
  expect(selected.end).toBeLessThan(moved.end);
  await (await revealControl(page.getByLabel("Time format"))).selectOption("samples");
  await (await revealControl(page.getByLabel("Amplitude scale"))).selectOption("db");
  await expect(page.getByTestId("waveform-channel-0")).toHaveAttribute("data-rendered", "true");
});

test("reopening an identically named file resets its viewport and selection", async ({ page }) => {
  await openWaveform(page);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  expect((await viewport(page)).end - (await viewport(page)).start).toBeLessThan(FRAMES);
  await page.getByTestId("audio-file-input").setInputFiles({
    name: "waveform.wav",
    mimeType: "audio/wav",
    buffer: waveformFixture(),
  });
  await expect.poll(() => viewport(page)).toEqual({ start: 0, end: FRAMES });
  await expect(page.getByTestId("waveform-channel-0")).toHaveAttribute("data-rendered", "true");
});

test("retains actual canvas pixels until delayed replacement peaks arrive after zoom and pan", async ({
  page,
}) => {
  await openWaveform(page);
  const canvas = page.getByTestId("waveform-channel-0");
  for (const action of ["zoom", "pan"] as const) {
    const painted = await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
    await page.evaluate(() => {
      const worker = window.__aaeTest?.workers[0];
      const probe = window.__aaeProcessProbe;
      if (!worker || !probe) throw new Error("kernel probe missing");
      Object.assign(window, { __r7ResumePeaks: probe.holdCalls(worker, ["peaks.get"]) });
    });
    if (action === "zoom") await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    else {
      const bounds = await canvas.boundingBox();
      if (!bounds) throw new Error("canvas bounds missing");
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.wheel(180, 0);
    }
    await expect(canvas).toHaveAttribute("aria-busy", "true");
    await expect(canvas).toHaveAttribute("data-rendered", "false");
    expect(await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL())).toBe(
      painted,
    );
    await page.evaluate(() => (window as unknown as { __r7ResumePeaks(): void }).__r7ResumePeaks());
    await expect(canvas).toHaveAttribute("data-rendered", "true");
    expect(await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL())).not.toBe(
      painted,
    );
  }
});
