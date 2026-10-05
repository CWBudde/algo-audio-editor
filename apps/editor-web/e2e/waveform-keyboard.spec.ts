/// <reference lib="dom" />

import type { DocumentInfoResult, ExportResult, SelectionResult } from "@aae/protocol";
import { expect, type Page, test } from "@playwright/test";
import { load, select } from "./edit-fixture.ts";
import { sourceState } from "./export-fixture.ts";
import { captureKernelWorker } from "./kernel-probe.ts";
import { revealControl } from "./ui-disclosures.ts";

const FRAMES = 96_000;
const CHANNELS = [
  Array.from({ length: FRAMES }, (_, frame) => ((frame % 256) - 128) / 256),
  Array.from({ length: FRAMES }, (_, frame) => (127 - (frame % 128)) / 256),
];

declare global {
  interface Window {
    __aaeKeyboardSeeks?: { frame: number; position?: number }[];
  }
}

async function open(page: Page) {
  await captureKernelWorker(page);
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.__aaeKeyboardSeeks = [];
    window.Worker = class extends NativeWorker {
      override postMessage(
        message: unknown,
        transfer?: Transferable[] | StructuredSerializeOptions,
      ) {
        const request = message as { id?: number; method?: string; params?: { frame: number } };
        if (
          request.method === "transport.seek" &&
          request.id !== undefined &&
          request.id >= 0 &&
          request.params
        ) {
          const seek = { frame: request.params.frame, position: undefined as number | undefined };
          window.__aaeKeyboardSeeks?.push(seek);
          const onReply = (event: MessageEvent) => {
            if (event.data.kind !== "reply" || event.data.id !== request.id) return;
            this.removeEventListener("message", onReply);
            if (event.data.ok) seek.position = event.data.result.position;
          };
          this.addEventListener("message", onReply);
        }
        if (Array.isArray(transfer)) super.postMessage(message, transfer);
        else super.postMessage(message, transfer);
      }
    };
  });
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
  await load(page, CHANNELS);
  await expect(page.getByTestId("waveform-channel-0")).toHaveAttribute("data-rendered", "true");
  await expect(page.getByTestId("waveform-channel-1")).toHaveAttribute("data-rendered", "true");
}

async function range(page: Page) {
  return page.evaluate(async () => {
    const probe = window.__aaeTest;
    if (!probe) throw new Error("kernel probe missing");
    const document = (await probe.request("doc.info")) as DocumentInfoResult;
    const selection = (await probe.request("selection.get", {
      documentId: document.documentId,
    })) as SelectionResult;
    return { start: selection.start, end: selection.end, channelMask: selection.channelMask };
  });
}

async function exportedPCM(page: Page) {
  return page.evaluate(async () => {
    const result = (await window.__aaeTest?.request("doc.export", {
      format: "wav",
      bitDepth: 32,
      float: true,
    })) as ExportResult;
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", result.data));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  });
}

async function source(page: Page) {
  const { selection: _, ...state } = await sourceState(page);
  return { ...state, pcm: await exportedPCM(page) };
}

async function expectCursor(page: Page, frame: number) {
  await expect(page.getByTestId("play-position")).toHaveAttribute("data-frame", String(frame));
  await expect
    .poll(() => page.evaluate(() => window.__aaeKeyboardSeeks?.at(-1)?.position))
    .toBe(frame);
}

test("waveform keyboard moves exact frames, keeps a Shift anchor across crossings and respects bounds", async ({
  page,
}) => {
  await open(page);
  const before = await source(page);
  await select(page, 1_000, 1_000);
  const surface = page.getByRole("group", { name: "Channel 1 waveform editor", exact: true });
  await surface.focus();
  await expect(surface).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => range(page)).toEqual({ start: 1_001, end: 1_001, channelMask: 3 });
  await expectCursor(page, 1_001);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => range(page)).toEqual({ start: 1_000, end: 1_000, channelMask: 3 });
  await page.keyboard.down("Shift");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => range(page)).toEqual({ start: 1_000, end: 1_002, channelMask: 3 });
  for (let index = 0; index < 4; index++) await page.keyboard.press("ArrowLeft");
  await expect.poll(() => range(page)).toEqual({ start: 998, end: 1_000, channelMask: 3 });
  await page.keyboard.up("Shift");
  await expectCursor(page, 998);
  await page.keyboard.press("Home");
  await expectCursor(page, 0);
  await page.evaluate(() => {
    window.__aaeKeyboardSeeks = [];
  });
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => range(page)).toEqual({ start: 0, end: 0, channelMask: 3 });
  expect(await page.evaluate(() => window.__aaeKeyboardSeeks)).toEqual([]);
  // An explicit boundary activation still seeks when the selection is already there.
  await page.keyboard.press("Home");
  await expectCursor(page, 0);
  expect(await page.evaluate(() => window.__aaeKeyboardSeeks)).toEqual([{ frame: 0, position: 0 }]);
  await page.evaluate(() => {
    window.__aaeKeyboardSeeks = [];
  });
  await page.keyboard.press("End");
  await expect.poll(() => range(page)).toEqual({ start: FRAMES, end: FRAMES, channelMask: 3 });
  await expectCursor(page, FRAMES);
  // End belongs to the focused surface; the global transport shortcut must not also run.
  expect(await page.evaluate(() => window.__aaeKeyboardSeeks)).toEqual([
    { frame: FRAMES, position: FRAMES },
  ]);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => range(page)).toEqual({ start: FRAMES, end: FRAMES, channelMask: 3 });
  await page.keyboard.press("Shift+Home");
  await expect.poll(() => range(page)).toEqual({ start: 0, end: FRAMES, channelMask: 3 });
  await expectCursor(page, 0);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => range(page)).toEqual({ start: FRAMES, end: FRAMES, channelMask: 3 });
  await select(page, 2_000, 4_000);
  await surface.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => range(page)).toEqual({ start: 2_000, end: 2_000, channelMask: 3 });
  expect(await source(page)).toEqual(before);
});

test("selection edges expose exact slider values, accelerated keys and commit repeated keys on blur", async ({
  page,
}) => {
  await open(page);
  const before = await source(page);
  await select(page, 10_000, 20_000);
  await (
    await revealControl(
      page.getByRole("button", { name: "Right", exact: true, includeHidden: true }),
    )
  ).click();
  await expect.poll(() => range(page)).toEqual({ start: 10_000, end: 20_000, channelMask: 2 });
  await expect(page.getByRole("slider", { name: "Selection start edge channel 1" })).toHaveCount(0);
  const start = page.getByRole("slider", { name: "Selection start edge channel 2", exact: true });
  const end = page.getByRole("slider", { name: "Selection end edge channel 2", exact: true });
  await expect(start).toHaveAttribute("aria-valuemin", "0");
  await expect(start).toHaveAttribute("aria-valuemax", "20000");
  await expect(end).toHaveAttribute("aria-valuemin", "10000");
  await expect(end).toHaveAttribute("aria-valuemax", String(FRAMES));
  await expect(start).toHaveAttribute("aria-valuenow", "10000");
  await expect(start).toHaveAttribute("aria-valuetext", /10000|10,000/);
  await end.focus();
  await page.keyboard.press("ArrowRight");
  await expect(end).toHaveAttribute("aria-valuenow", "20001");
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(end).toHaveAttribute("aria-valuenow", "19991");
  await page.keyboard.press("PageUp");
  await expect.poll(() => range(page)).toEqual({ start: 10_000, end: 67_991, channelMask: 2 });
  await expect(end).toHaveAttribute("aria-valuenow", "67991");
  await start.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => range(page)).toEqual({ start: 10_009, end: 67_991, channelMask: 2 });
  await page.keyboard.press("PageDown");
  await expect.poll(() => range(page)).toEqual({ start: 0, end: 67_991, channelMask: 2 });
  await page.keyboard.press("Shift+PageUp");
  await expect.poll(() => range(page)).toEqual({ start: 67_991, end: 67_991, channelMask: 2 });
  await expect(start).toBeFocused();
  await page.keyboard.press("Home");
  await expect(start).toHaveAttribute("aria-valuenow", "0");
  await select(page, 10_000, 20_000);
  await end.focus();
  // Browser key repeat is synchronous here, so blur must flush the final optimistic range.
  await end.evaluate((element) => {
    for (let index = 0; index < 40; index++)
      element.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", repeat: index > 0, bubbles: true }),
      );
  });
  await page.keyboard.press("Tab");
  await expect(end).not.toBeFocused();
  await expect.poll(() => range(page)).toEqual({ start: 10_000, end: 20_040, channelMask: 2 });
  await expectCursor(page, 20_040);
  expect(await source(page)).toEqual(before);
});

test("pointer focuses a waveform without changing channel targeting and shortcuts respect input and modal fences", async ({
  page,
}) => {
  await open(page);
  const before = await source(page);
  await (
    await revealControl(
      page.getByRole("button", { name: "Right", exact: true, includeHidden: true }),
    )
  ).click();
  const surface = page.getByRole("group", { name: "Channel 1 waveform editor", exact: true });
  await page.getByTestId("waveform-channel-0").click({ position: { x: 200, y: 80 } });
  await expect(surface).toBeFocused();
  const clicked = await range(page);
  expect(clicked.channelMask).toBe(2);
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => range(page))
    .toEqual({
      start: clicked.start + 1,
      end: clicked.start + 1,
      channelMask: 2,
    });
  await select(page, 1_000, 1_000);
  await surface.focus();
  const fenced = await range(page);
  await page.keyboard.press("Control+ArrowRight");
  await page.keyboard.press("Alt+ArrowLeft");
  expect(await range(page)).toEqual(fenced);
  const input = page.getByLabel("Selection start", { exact: true });
  await input.focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  expect(await range(page)).toEqual(fenced);
  await page.keyboard.press("Control+Shift+E");
  const dialog = page.getByRole("dialog", { name: "Export audio" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Home");
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowRight");
  expect(await range(page)).toEqual(fenced);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  expect(await source(page)).toEqual(before);
});
