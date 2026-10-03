/// <reference lib="dom" />
import type { DocumentInfoResult, SelectionResult, TimelineResult } from "@aae/protocol";
import { expect, type Page, test } from "@playwright/test";
import { captureKernelWorker } from "./kernel-probe.ts";

const FRAMES = 48_000;

/** Each channel crosses zero at a different known boundary, without zero samples. */
function fixture() {
  const bytes = Buffer.alloc(44 + FRAMES * 4);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(48_000, 24);
  bytes.writeUInt32LE(192_000, 28);
  bytes.writeUInt16LE(4, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(FRAMES * 4, 40);
  for (let frame = 0; frame < FRAMES; frame++) {
    bytes.writeInt16LE(frame < 12_000 ? -8192 : 8192, 44 + frame * 4);
    bytes.writeInt16LE(frame < 36_000 ? 16384 : -16384, 46 + frame * 4);
  }
  return bytes;
}

async function open(page: Page) {
  await captureKernelWorker(page);
  await page.goto("/");
  await expect(page.getByTestId("kernel-status")).toHaveText("kernel ready");
  await page
    .getByTestId("audio-file-input")
    .setInputFiles({ name: "selection.wav", mimeType: "audio/wav", buffer: fixture() });
  await expect(page.getByTestId("waveform-channel-0")).toHaveAttribute("data-rendered", "true");
  await page.getByLabel("Time format", { exact: true }).selectOption("samples");
}

async function selection(page: Page) {
  return page.evaluate(async () => {
    const info = (await window.__aaeTest?.request("doc.info")) as DocumentInfoResult;
    return (await window.__aaeTest?.request("selection.get", {
      documentId: info.documentId,
    })) as SelectionResult;
  });
}

async function range(page: Page) {
  const result = await selection(page);
  return { start: result.start, end: result.end, channelMask: result.channelMask };
}

async function entry(page: Page, field: "start" | "end" | "length", value: string) {
  const input = page.getByLabel(`Selection ${field}`, { exact: true });
  await input.fill(value);
  await input.press("Enter");
}

async function point(page: Page, frame: number) {
  const bounds = await page.getByTestId("waveform-channel-0").boundingBox();
  if (!bounds) throw new Error("missing waveform");
  return {
    x: bounds.x + (frame / FRAMES) * bounds.width,
    y: bounds.y + bounds.height / 2,
    width: bounds.width,
  };
}

test("numeric entry preserves exact frames across formats and targets arbitrary channels", async ({
  page,
}) => {
  await open(page);
  await entry(page, "end", "24,001");
  await entry(page, "start", "12001");
  await expect.poll(() => range(page)).toEqual({ start: 12_001, end: 24_001, channelMask: 3 });
  await page.getByRole("button", { name: "Right", exact: true }).click();
  await expect.poll(() => range(page)).toEqual({ start: 12_001, end: 24_001, channelMask: 2 });
  await expect(page.getByTestId("waveform-selection")).toHaveCount(0);
  await expect(page.getByTestId("waveform-selection-1")).toBeVisible();
  await page.getByLabel("Channel 1 selected", { exact: true }).check();
  await expect.poll(() => range(page)).toEqual({ start: 12_001, end: 24_001, channelMask: 3 });
  await page.getByLabel("Time format", { exact: true }).selectOption("seconds");
  await entry(page, "length", "0.125");
  await expect.poll(() => range(page)).toEqual({ start: 12_001, end: 18_001, channelMask: 3 });
  await page.getByLabel("Time format", { exact: true }).selectOption("hms");
  await entry(page, "end", "0:00:00.500020833");
  await expect.poll(() => range(page)).toEqual({ start: 12_001, end: 24_001, channelMask: 3 });
  await entry(page, "start", "0:00:99");
  await expect(page.getByLabel("Selection start", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect.poll(() => range(page)).toEqual({ start: 12_001, end: 24_001, channelMask: 3 });
  await page.getByLabel("Selection start", { exact: true }).press("Escape");
  await expect(page.getByLabel("Selection start", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "false",
  );
});

test("mouse click, Shift extension, edges and double-click update authoritative selection", async ({
  page,
}) => {
  await open(page);
  const a = await point(page, 10_000);
  const b = await point(page, 20_000);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
  await expect
    .poll(async () => (await selection(page)).end - (await selection(page)).start)
    .toBeGreaterThan(9_900);
  const initial = await selection(page);
  const c = await point(page, 30_000);
  await page.keyboard.down("Shift");
  await page.mouse.click(c.x, c.y);
  await page.keyboard.up("Shift");
  await expect.poll(async () => (await selection(page)).end).toBeGreaterThan(29_900);
  expect((await selection(page)).start).toBe(initial.start);
  const handle = page.getByTestId("selection-start-edge-0");
  const bounds = await handle.boundingBox();
  if (!bounds) throw new Error("missing selection edge");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + a.width / 10, bounds.y + bounds.height / 2, {
    steps: 4,
  });
  await page.mouse.up();
  await expect
    .poll(async () => (await selection(page)).start)
    .toBeGreaterThan(initial.start + 4_700);
  await page.mouse.dblclick(c.x, c.y);
  await expect.poll(() => range(page)).toEqual({ start: 0, end: FRAMES, channelMask: 3 });
});

test("named regions and markers are usable snapping and double-click targets", async ({ page }) => {
  await open(page);
  await entry(page, "end", "20000");
  await entry(page, "start", "10000");
  await page.getByLabel("Marker or region name").fill("Verse");
  await page.getByRole("button", { name: "Add region", exact: true }).click();
  await expect(page.getByTestId("timeline-region-1")).toBeVisible();
  const inside = await point(page, 15_000);
  await page.mouse.dblclick(inside.x, inside.y);
  await expect.poll(() => range(page)).toEqual({ start: 10_000, end: 20_000, channelMask: 3 });
  await page.getByLabel("Marker or region name").fill("Cue");
  await page.getByRole("button", { name: "Add marker", exact: true }).click();
  await expect(page.getByTestId("timeline-marker-2")).toBeVisible();
  await page.getByLabel("Markers / regions", { exact: true }).check();
  const near = await point(page, 10_000);
  await page.mouse.click(near.x + 5, near.y);
  await expect.poll(() => range(page)).toEqual({ start: 10_000, end: 10_000, channelMask: 3 });
  const result = await page.evaluate(async () => {
    const info = (await window.__aaeTest?.request("doc.info")) as DocumentInfoResult;
    return (await window.__aaeTest?.request("timeline.get", {
      documentId: info.documentId,
    })) as TimelineResult;
  });
  expect(result.markers).toEqual([{ id: 2, frame: 10_000, name: "Cue" }]);
  expect(result.regions).toEqual([{ id: 1, start: 10_000, end: 20_000, name: "Verse" }]);
});

test("zero snapping follows the selected channel and ruler snapping uses displayed ticks", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("button", { name: "Left", exact: true }).click();
  await page.getByLabel("Zero crossings", { exact: true }).check();
  const left = await point(page, 12_000);
  await page.mouse.click(left.x + 2, left.y);
  await expect.poll(() => range(page)).toEqual({ start: 12_000, end: 12_000, channelMask: 1 });
  await page.getByRole("button", { name: "Right", exact: true }).click();
  const right = await point(page, 36_000);
  await page.mouse.click(right.x - 2, right.y);
  await expect.poll(() => range(page)).toEqual({ start: 36_000, end: 36_000, channelMask: 2 });
  await page.getByLabel("Zero crossings", { exact: true }).uncheck();
  await page.getByLabel("Time format", { exact: true }).selectOption("seconds");
  await page.getByLabel("Ruler ticks", { exact: true }).check();
  const tick = page.getByTestId("waveform-time-ruler").getByText("0.5 s", { exact: true });
  const bounds = await tick.boundingBox();
  if (!bounds) throw new Error("missing half-second ruler tick");
  const lane = await point(page, 24_000);
  await page.mouse.click(lane.x + 2, lane.y);
  await expect.poll(() => range(page)).toEqual({ start: 24_000, end: 24_000, channelMask: 2 });
});

test("reopening an identical file resets selection and anchors and rejects the old identity", async ({
  page,
}) => {
  await open(page);
  await entry(page, "end", "24000");
  await page.getByRole("button", { name: "Left", exact: true }).click();
  await page.getByRole("button", { name: "Add region", exact: true }).click();
  await expect(page.getByTestId("timeline-region-1")).toBeVisible();
  const old = await selection(page);
  await page
    .getByTestId("audio-file-input")
    .setInputFiles({ name: "selection.wav", mimeType: "audio/wav", buffer: fixture() });
  await expect.poll(async () => (await selection(page)).documentId).not.toBe(old.documentId);
  await expect.poll(() => range(page)).toEqual({ start: 0, end: 0, channelMask: 3 });
  await expect(page.getByTestId("timeline-region-1")).toHaveCount(0);
  const error = await page.evaluate(async (old) => {
    try {
      await window.__aaeTest?.request("selection.set", old);
      return "accepted";
    } catch (error) {
      return String(error);
    }
  }, old);
  expect(error).toContain("stale or invalid document identity");
  await expect.poll(() => range(page)).toEqual({ start: 0, end: 0, channelMask: 3 });
});
