import { expect, type Page, test } from "@playwright/test";
import { playbackWAV } from "./playback-fixture.js";

import { capturePlayback } from "./playback-probe.ts";

async function open(page: Page, frames: number, sampleRate = 48000, channels = 2) {
  await page.goto("/");
  await expect(page.getByTestId("kernel-status")).toHaveText("kernel ready");
  await page.getByTestId("audio-file-input").setInputFiles({
    name: "transport.wav",
    mimeType: "audio/wav",
    buffer: playbackWAV(frames, sampleRate, channels),
  });
  await expect(page.getByTestId("document-name")).toHaveText("transport.wav");
}

test("short files drain exactly once without EOF underruns and can replay", async ({ page }) => {
  await open(page, 31);
  await page.getByTestId("play").click();
  await expect(page.getByTestId("play")).toBeEnabled();
  await expect(page.getByTestId("play-position")).toHaveAttribute("data-frame", "31");
  await expect(page.getByTestId("frames-played")).toHaveText("31");
  await expect(page.getByTestId("underruns")).toHaveText("0");
  await page.getByTestId("play").click();
  await expect(page.getByTestId("play")).toBeEnabled();
  await expect(page.getByTestId("frames-played")).toHaveText("31");
});

test("the production worklet outputs document samples and an audible cursor @timing", async ({
  page,
}) => {
  await capturePlayback(page);
  await open(page, 144000);
  await page.getByTestId("play").click();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const probe = window.__aaePlaybackProbe;
        if (!probe) return [];
        return probe.analysers.map((analyser) => {
          const samples = new Float32Array(256);
          analyser.getFloatTimeDomainData(samples);
          return Array.from(samples).every((sample) => sample === samples[0]) ? samples[0] : null;
        });
      }),
    )
    .toEqual([0.5, -0.25]);
  const timing = await page.evaluate(() => {
    const context = window.__aaePlaybackProbe?.context;
    if (!context) throw new Error("playback context missing");
    const timestamp = context.getOutputTimestamp();
    return {
      rate: context.sampleRate,
      contextTime: context.currentTime,
      audibleTime: timestamp.contextTime ?? 0,
      outputLatency: context.outputLatency,
    };
  });
  expect(timing.contextTime).toBeGreaterThanOrEqual(timing.audibleTime);
  // Observe the actual cursor paint call, comparing with the device clock.
  // A later MutationObserver callback measures intervening task/scheduler time,
  // not the cursor's clock accuracy at its animation-frame update.
  const errors = await page.evaluate(async () => {
    const probe = window.__aaePlaybackProbe;
    const cursor = document.querySelector<HTMLElement>("[data-testid='play-cursor-0']");
    if (!probe || !cursor) throw new Error("playback probe/cursor missing");
    const counters = new BigInt64Array(probe.ring.sab, 16, 8);
    return new Promise<{ deltas: number[]; underruns: number; readings: number[][] }>(
      (resolve, reject) => {
        const deltas: number[] = [];
        const readings: number[][] = [];
        const nativeSetAttribute = Element.prototype.setAttribute;
        const timeout = setTimeout(() => {
          Element.prototype.setAttribute = nativeSetAttribute;
          reject(new Error("cursor timing probe timed out"));
        }, 5000);
        Element.prototype.setAttribute = function (name: string, value: string) {
          nativeSetAttribute.call(this, name, value);
          if (this !== cursor || name !== "data-frame") return;
          const timestamp = probe.context.getOutputTimestamp();
          if (!(timestamp.performanceTime && timestamp.contextTime)) return;
          const audible = Math.floor(
            (timestamp.contextTime + (performance.now() - timestamp.performanceTime) / 1000) *
              probe.context.sampleRate,
          );
          const first = Number(Atomics.load(counters, 7));
          const end = Number(Atomics.load(counters, 3));
          const expected = Math.min(audible, end - 1) - first + 1;
          const actual = Number(value);
          deltas.push(Math.abs(actual - expected));
          readings.push([
            actual,
            expected,
            audible,
            first,
            end,
            timestamp.contextTime,
            timestamp.performanceTime,
          ]);
          if (deltas.length >= 20) {
            clearTimeout(timeout);
            Element.prototype.setAttribute = nativeSetAttribute;
            resolve({
              deltas,
              readings,
              underruns: Atomics.load(new Int32Array(probe.ring.sab, 0, 4), 2),
            });
          }
        };
      },
    );
  });
  await test.info().attach("cursor-device-clock", {
    body: JSON.stringify(errors),
    contentType: "application/json",
  });
  console.info("Cursor device-clock gate", {
    samples: errors.deltas.length,
    maxFrameError: Math.max(...errors.deltas),
    underruns: errors.underruns,
  });
  expect(errors.underruns).toBe(0);
  expect(Math.max(...errors.deltas)).toBeLessThanOrEqual(128);
  await page.getByTestId("stop").click();
  await expect(page.getByTestId("underruns")).toHaveText("0");
});

test("space toggles document playback and Home/End seek without stealing input keys", async ({
  page,
}) => {
  await open(page, 480000);
  await page.locator("body").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("Space");
  await expect
    .poll(async () => Number(await page.getByTestId("play-position").getAttribute("data-frame")))
    .toBeGreaterThan(1000);
  await page.keyboard.press("End");
  await expect(page.getByTestId("play-position")).toHaveAttribute("data-frame", "480000");
  await expect(page.getByTestId("play")).toBeEnabled();
  await page.keyboard.press("Home");
  await expect(page.getByTestId("play-position")).toHaveAttribute("data-frame", "0");
  await page.keyboard.press("Space");
  await expect(page.getByTestId("stop")).toBeEnabled();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("play")).toBeEnabled();
  await expect(page.getByTestId("frames-played")).toHaveText("0");
  await page.getByLabel("Follow playback").focus();
  await page.keyboard.press("Home");
  await expect(page.getByTestId("play")).toBeEnabled();
});

test("loops a selected document range and follows its consumed cursor", async ({ page }) => {
  await open(page, 48000);
  const canvas = page.getByTestId("waveform-channel-0");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("waveform canvas missing");
  await page.mouse.move(bounds.x + bounds.width * 0.25, bounds.y + 60);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + 60);
  await page.mouse.up();
  await page.getByLabel("Loop", { exact: true }).check();
  await page.getByTestId("play").click();
  await expect
    .poll(async () => Number(await page.getByTestId("frames-played").textContent()))
    .toBeGreaterThan(48000);
  const frame = Number(await page.getByTestId("play-position").getAttribute("data-frame"));
  expect(frame).toBeGreaterThanOrEqual(11900);
  expect(frame).toBeLessThanOrEqual(24100);
  await expect(page.getByTestId("play-cursor-0")).toBeVisible();
  await expect(page.getByTestId("play-cursor-1")).toBeVisible();
  await expect(page.getByTestId("underruns")).toHaveText("0");
  await page.getByTestId("stop").click();
});

test("44.1 kHz playback uses the context rate while retaining document positions", async ({
  page,
}) => {
  await open(page, 44100, 44100, 1);
  await page.getByTestId("play").click();
  await expect(page.getByTestId("play")).toBeEnabled();
  await expect(page.getByTestId("play-position")).toHaveAttribute("data-frame", "44100");
  // Chromium's context defaults to 48 kHz on the test host. The exact
  // context count is checked by the native/WASM transport tests as well.
  const consumed = Number(await page.getByTestId("frames-played").textContent());
  expect([44100, 48000]).toContain(consumed);
  await expect(page.getByTestId("underruns")).toHaveText("0");
});
