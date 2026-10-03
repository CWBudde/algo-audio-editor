/// <reference lib="dom" />
import { expect, type Locator, type Page, test } from "@playwright/test";
import { fixture, load, samples } from "./edit-fixture.ts";
import { captureEffectTiming } from "./effect-timing-probe.ts";
import { sourceState } from "./export-fixture.ts";
import { captureKernelWorker } from "./kernel-probe.ts";
import { capturePlayback } from "./playback-probe.ts";

interface ChangeTiming {
  audibleMs: number;
  renderFrame: number;
  eventContextTime: number;
  eventTimestamp: AudioTimestamp;
  outputTimestamp: AudioTimestamp;
  baseLatency: number;
  outputLatency: number;
  sampleRate: number;
  requestMs?: number;
  ackMs?: number;
  horizons: number[];
  underruns: number;
}

async function measureChange(page: Page, input: Locator, value: string, mode: 1 | 2 | 3) {
  await page.evaluate(async () => {
    if (!window.__aaeEffectTiming) throw new Error("timing tap missing");
    await window.__aaeEffectTiming.ready;
  });
  console.log(
    "effects playback before warmup",
    JSON.stringify(
      await page.evaluate(() => {
        const context = window.__aaePlaybackProbe?.context;
        if (!context) throw new Error("playback context missing");
        return {
          baseLatency: context.baseLatency,
          outputLatency: context.outputLatency,
          sampleRate: context.sampleRate,
          currentTime: context.currentTime,
          outputTimestamp: context.getOutputTimestamp(),
          horizons: window.__aaeEffectTiming?.horizons,
        };
      }),
    ),
  );
  // Let the real device pipeline reach steady playback before changing a
  // parameter. Startup output timestamps are not a steady audio clock.
  await assertStablePlayback(page);
  // Verify the old production signal before arming. Neither a queued old
  // sample nor the identity pitch can satisfy the changed-signal detector.
  await expect
    .poll(() =>
      page.evaluate((detectionMode) => {
        const analyser = window.__aaePlaybackProbe?.analysers[0];
        if (!analyser) throw new Error("playback analyser missing");
        analyser.fftSize = 64;
        const values = new Float32Array(64);
        analyser.getFloatTimeDomainData(values);
        if (detectionMode === 1) return Array.from(values).every((sample) => sample === 0);
        if (detectionMode === 3)
          return Array.from(values).every((sample) => sample > 0.2 && sample < 0.3);
        let crossings = 0;
        for (let index = 1; index < values.length; index++)
          if (values[index] > 0 !== values[index - 1] > 0) crossings++;
        return (
          crossings >= 2 &&
          crossings <= 3 &&
          Array.from(values).some((sample) => Math.abs(sample) > 0.1)
        );
      }, mode),
    )
    .toBe(true);
  await input.evaluate((element, detectionMode) => {
    const probe = window.__aaePlaybackProbe;
    const timing = window.__aaeEffectTiming;
    if (!probe || !timing) throw new Error("production playback probes missing");
    const context = probe.context;
    const header = new Int32Array(probe.ring.sab, 0, 4);
    const scope = window as unknown as { __effectChangeTiming: Promise<ChangeTiming> };
    scope.__effectChangeTiming = new Promise((resolve, reject) => {
      element.addEventListener(
        "input",
        () => {
          const started = performance.now();
          const eventContextTime = context.currentTime;
          const eventTimestamp = context.getOutputTimestamp();
          const underruns = Atomics.load(header, 2);
          const updateIndex = timing.updates.length;
          timing.frame[0] = -1;
          Atomics.store(timing.control, 1, detectionMode);
          Atomics.store(timing.control, 0, 1);
          const timer = setInterval(() => {
            // The atomic completion flag publishes the preceding Float64
            // frame store without constructing BigInts on the audio thread.
            const renderFrame = Atomics.load(timing.control, 0) === 2 ? timing.frame[0] : -1;
            const outputTimestamp = context.getOutputTimestamp();
            // Map the exact captured sample after the device clock reaches it;
            // a delayed main-thread poll cannot inflate or hide the result.
            if (
              renderFrame >= 0 &&
              (outputTimestamp.contextTime ?? 0) >= renderFrame / context.sampleRate
            ) {
              clearInterval(timer);
              const update = timing.updates[updateIndex];
              const audibleAt =
                (outputTimestamp.performanceTime ?? 0) +
                (renderFrame / context.sampleRate - (outputTimestamp.contextTime ?? 0)) * 1000;
              resolve({
                audibleMs: audibleAt - started,
                renderFrame,
                eventContextTime,
                eventTimestamp,
                outputTimestamp,
                baseLatency: context.baseLatency,
                outputLatency: context.outputLatency,
                sampleRate: context.sampleRate,
                requestMs: update ? update.requestAt - started : undefined,
                ackMs: update?.ackAt === undefined ? undefined : update.ackAt - started,
                horizons: [...timing.horizons],
                underruns: Atomics.load(header, 2) - underruns,
              });
            } else if (performance.now() - started > 5000) {
              clearInterval(timer);
              reject(new Error(`production audio did not reach changed frame ${renderFrame}`));
            }
          }, 2);
        },
        { once: true, capture: true },
      );
    });
  }, mode);
  await input.fill(value);
  const timing = await page.evaluate(
    async () =>
      (window as unknown as { __effectChangeTiming: Promise<ChangeTiming> }).__effectChangeTiming,
  );
  console.log("effects exact audible timing", JSON.stringify(timing));
  return timing;
}

async function assertStablePlayback(page: Page) {
  const before = await page.evaluate(() => {
    const ring = window.__aaePlaybackProbe?.ring;
    if (!ring) throw new Error("playback ring missing");
    return Atomics.load(new Int32Array(ring.sab, 0, 4), 2);
  });

  await page.waitForTimeout(1000);
  const after = await page.evaluate(() => {
    const ring = window.__aaePlaybackProbe?.ring;
    if (!ring) throw new Error("playback ring missing");
    return Atomics.load(new Int32Array(ring.sab, 0, 4), 2);
  });
  expect(after - before, "preview underruns during one second of live playback").toBe(0);
}

async function applyRack(dialog: Locator) {
  await dialog.getByRole("button", { name: "Apply rack", exact: true }).click();
  await expect
    .poll(async () => {
      const [status] = await dialog.getByTestId("effects-status").allTextContents();
      return status === undefined
        ? "closed"
        : status === "Review output levels"
          ? "review"
          : "working";
    })
    .not.toBe("working");
  if (await dialog.isVisible())
    await dialog.getByRole("button", { name: "Apply anyway", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await captureKernelWorker(page);
  await capturePlayback(page);
  await captureEffectTiming(page);
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
});

test("effect parameter change reaches audible output within 50 ms @timing", async ({ page }) => {
  const source = Array.from({ length: 48000 }, () => 0.5);
  await load(page, [source]);
  await page.getByRole("menuitem", { name: "Effects", exact: true }).click();
  await page.locator('[role="menuitem"][data-command-id="effects.distortion"]').click();
  const dialog = page.getByRole("dialog", { name: "Effects rack" });
  await expect(dialog.getByTestId("effects-status")).toHaveText("Ready");
  await dialog.getByLabel("Mode", { exact: true }).selectOption("hardclip");
  await dialog.getByLabel("Drive", { exact: true }).fill("1");
  await dialog.getByLabel("Output", { exact: true }).fill("0");
  await dialog.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(dialog.getByTestId("effects-status")).toHaveText("Previewing live effects");
  const timing = await measureChange(page, dialog.getByLabel("Output", { exact: true }), "1", 1);
  expect(timing.audibleMs).toBeGreaterThanOrEqual(0);
  expect(timing.audibleMs).toBeLessThan(50);
  expect(timing.underruns, "preview underruns during the parameter change").toBe(0);
  await assertStablePlayback(page);
  const preview = await page.evaluate(() => {
    const values = new Float32Array(32);
    const analyser = window.__aaePlaybackProbe?.analysers[0];
    if (!analyser) throw new Error("playback analyser missing");
    analyser.fftSize = 32;
    analyser.getFloatTimeDomainData(values);
    return Array.from(values);
  });
  expect(preview.every((value) => value === 0.5)).toBe(true);
  await applyRack(dialog);
  expect(await samples(page)).toEqual([source]);
});

for (const effectId of ["pitch-time", "pitch-spectral"] as const)
  test(`${effectId} live +12 semitone change is audible within 50 ms @timing`, async ({ page }) => {
    const source = Array.from({ length: 96000 }, (_, index) =>
      Math.fround(0.25 * Math.sin((2 * Math.PI * 1000 * index) / 48000)),
    );
    await load(page, [source]);
    await page.getByRole("menuitem", { name: "Effects", exact: true }).click();
    await page.locator(`[role="menuitem"][data-command-id="effects.${effectId}"]`).click();
    const dialog = page.getByRole("dialog", { name: "Effects rack" });
    await expect(dialog.getByTestId("effects-status")).toHaveText("Ready");
    await dialog.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(dialog.getByTestId("effects-status")).toHaveText("Previewing live effects");
    const timing = await measureChange(
      page,
      dialog.getByLabel("Semitones", { exact: true }),
      "12",
      2,
    );
    expect(timing.audibleMs).toBeGreaterThanOrEqual(0);
    expect(timing.audibleMs).toBeLessThan(50);
    expect(timing.underruns, "preview underruns during the pitch change").toBe(0);
    await assertStablePlayback(page);
    await applyRack(dialog);
    expect((await samples(page))[0].some((value) => Math.abs(value) > 0.05)).toBe(true);
  });

for (const change of ["convolution-wet", "following-distortion"] as const)
  test(`${change} with a two-second stereo IR reaches audible output within 50 ms @timing`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const source = Array.from({ length: 48000 }, () => 0.25);
    await load(page, [source, source]);
    const before = await sourceState(page);
    await page.getByRole("menuitem", { name: "Effects", exact: true }).click();
    await page.locator('[role="menuitem"][data-command-id="effects.reverb-conv"]').click();
    const dialog = page.getByRole("dialog", { name: "Effects rack" });
    await expect(dialog.getByTestId("effects-status")).toHaveText("Ready");
    // Both channels have a 0.5 first tap and a dense, decaying positive tail.
    // With dry=1, DC0.25 is below0.3 at wet0 and above0.35 at wet1.
    const impulse = [0.25, 0.125].map((tail) =>
      Array.from({ length: 96000 }, (_, index) =>
        index === 0 ? 0.5 : Math.fround((tail / 12000) * Math.exp(-index / 12000)),
      ),
    );
    await dialog.getByLabel("Impulse response WAV", { exact: true }).setInputFiles({
      name: "two-second-stereo-ir.wav",
      mimeType: "audio/wav",
      buffer: fixture(impulse, 48000),
    });
    await expect(dialog.getByRole("button", { name: "Preview", exact: true })).toBeEnabled();
    const convolution = dialog.locator('[data-effect-id="reverb-conv"]');
    await convolution
      .getByLabel("Wet", { exact: true })
      .fill(change === "convolution-wet" ? "0" : "1");
    if (change === "following-distortion") {
      await dialog.getByLabel("Add effect", { exact: true }).selectOption("distortion");
      await dialog.getByRole("button", { name: "Add", exact: true }).click();
      const distortion = dialog.locator('[data-effect-id="distortion"]');
      await distortion.getByLabel("Mode", { exact: true }).selectOption("hardclip");
      await distortion.getByLabel("Drive", { exact: true }).fill("1");
      await distortion.getByLabel("Output", { exact: true }).fill("0");
    }
    await dialog.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(dialog.getByTestId("effects-status")).toHaveText("Previewing live effects");
    const input =
      change === "convolution-wet"
        ? convolution.getByLabel("Wet", { exact: true })
        : dialog.locator('[data-effect-id="distortion"]').getByLabel("Output", { exact: true });
    const timing = await measureChange(page, input, "1", change === "convolution-wet" ? 3 : 1);
    expect(timing.audibleMs).toBeGreaterThanOrEqual(0);
    expect(timing.audibleMs).toBeLessThan(50);
    expect(timing.underruns, "preview underruns during the convolution rack change").toBe(0);
    await assertStablePlayback(page);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(await sourceState(page)).toEqual(before);
    expect(await samples(page)).toEqual([source, source]);
  });
