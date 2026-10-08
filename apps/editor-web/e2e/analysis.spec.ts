import { expect, test } from "@playwright/test";
import {
  analysisCommand,
  pitchAndSpectrum,
  sine,
  statisticsAndClipping,
} from "./analysis-fixture.ts";
import { load } from "./edit-fixture.ts";
import { captureKernelWorker } from "./kernel-probe.ts";
import { capturePlayback } from "./playback-probe.ts";

test.beforeEach(async ({ page }) => {
  await captureKernelWorker(page);
  await capturePlayback(page);
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
});
test("selected-channel statistics and clipping markers preserve samples and create one undo entry", async ({
  page,
}) => {
  await statisticsAndClipping(page);
});
test("YIN pitch and FFT spectrum controls display kernel results without changing source", async ({
  page,
}) => {
  await pitchAndSpectrum(page);
});
test("lazy playback meters publish true peak, loudness, correlation and goniometer through the production SAB", async ({
  page,
}) => {
  const source = sine(48000 * 5);
  await load(page, [source, source]);
  expect(await page.evaluate(() => window.__aaeTest?.meterConfigurations)).toEqual([]);
  await analysisCommand(page, "analyze.meters");
  await page.getByTestId("play").click();
  const meters = page.getByRole("region", { name: "Playback output meters" });
  await expect(meters.getByRole("meter", { name: "Channel 1 peak" })).toHaveAttribute(
    "aria-valuenow",
    /-6\./,
  );
  await expect(meters).toContainText("True peak");
  await expect(meters).toContainText("dBTP");
  await expect(meters).toContainText("provisional");
  await expect(meters.getByRole("img", { name: "Mid/side goniometer" })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const sab = window.__aaeTest?.meterBuffer;
        if (!sab) return null;
        const header = new Int32Array(sab, 0, 2),
          data = new Float64Array(sab, 64, 192);
        const before = Atomics.load(header, 0);
        if (before & 1 || !Atomics.load(header, 1)) return null;
        const result = {
          channels: data[1],
          frames: data[2],
          peak: data[16],
          rms: data[17],
          truePeak: data[19],
          correlation: data[8],
          points: data[9],
          integrated: data[6],
        };
        return Atomics.load(header, 0) === before ? result : null;
      }),
    )
    .toMatchObject({ channels: 2, correlation: 1 });
  await analysisCommand(page, "analyze.spectrum");
  const spectrum = page.getByRole("region", { name: "Spectrum analyzer" });
  await spectrum.getByLabel("Source", { exact: true }).selectOption("playback");
  await spectrum.getByLabel("Averaging", { exact: true }).selectOption("64");
  const paths = spectrum.getByTestId("spectrum-path");
  await expect(paths).toHaveCount(2);
  for (const path of await paths.all()) await expect(path).toHaveAttribute("d", /^M/);
  await expect(spectrum.getByRole("alert")).toHaveCount(0);
  await expect(meters.getByRole("meter", { name: "Channel 1 peak" })).toHaveAttribute(
    "aria-valuenow",
    /-6\./,
  );
  await expect(meters.getByText("Play audio to read channel levels.")).toHaveCount(0);
  await spectrum.getByRole("button", { name: "Close spectrum" }).click();
  await meters.getByRole("button", { name: "Close meters" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__aaeTest?.meterConfigurations.at(-1)))
    .toEqual({ enabled: false });
  await page.getByTestId("stop").click();
});
test("spectrogram shares zoom, progressively paints and invalidates same-length gain and undo", async ({
  page,
}) => {
  await load(page, [sine(48000)]);
  await analysisCommand(page, "view.split-spectral", "View");
  const canvas = page.getByTestId("spectrogram-canvas-0");
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-completed-tiles")))
    .toBeGreaterThan(0);
  await expect
    .poll(async () => [
      await canvas.getAttribute("data-completed-tiles"),
      await canvas.getAttribute("data-total-tiles"),
    ])
    .toEqual(
      await Promise.all([
        canvas.getAttribute("data-total-tiles"),
        canvas.getAttribute("data-total-tiles"),
      ]),
    );
  // Compare the exact full image without serializing hundreds of thousands of RGBA numbers per poll.
  const pixels = () =>
    canvas.evaluate((node) => (node as HTMLCanvasElement).toDataURL("image/png"));
  const complete = () =>
    expect
      .poll(() =>
        canvas.evaluate((node) => {
          const canvas = node as HTMLElement,
            total = Number(canvas.dataset.totalTiles);
          return total > 0 && canvas.dataset.completedTiles === canvas.dataset.totalTiles;
        }),
      )
      .toBe(true);
  const original = await pixels();
  const state = await canvas.getAttribute("data-history-state");
  if (!state) throw new Error("history identity missing");
  await page.getByRole("menuitem", { name: "Process", exact: true }).click();
  await page.locator('[role=menuitem][data-command-id="process.amplify"]').click();
  const dialog = page.getByRole("dialog", { name: "Amplify" });
  await dialog.getByLabel("Gain (dB)", { exact: true }).fill("-12");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(canvas).not.toHaveAttribute("data-history-state", state);
  await complete();
  await expect.poll(pixels).not.toEqual(original);
  await page.getByTestId("document-details").click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(canvas).toHaveAttribute("data-history-state", state);
  await complete();
  await expect.poll(pixels).toEqual(original);
  await expect(canvas).toHaveAttribute(
    "data-start-frame",
    (await page.getByTestId("waveform-view").getAttribute("data-start-frame")) ?? "0",
  );
});
