import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { analysisCommand } from "./analysis-fixture.ts";
import { captureKernelWorker } from "./kernel-probe.ts";
import { playbackWAV } from "./playback-fixture.ts";
import { capturePlayback } from "./playback-probe.ts";

test("a ten-minute document progressively paints spectrogram tiles with live meters and zero playback underruns @timing", async ({
  page,
}) => {
  test.setTimeout(180000);
  await captureKernelWorker(page);
  await capturePlayback(page);
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
  const frames = 48000 * 600;
  const directory = await mkdtemp(path.join(tmpdir(), "aae-spectrogram-"));
  try {
    const file = path.join(directory, "ten-minute-stereo.wav");
    await writeFile(file, playbackWAV(frames));
    await page.getByTestId("audio-file-input").setInputFiles(file);
    await expect(page.getByTestId("document-details")).toContainText(`${frames} frames`);
    await analysisCommand(page, "analyze.meters");
    await page.getByTestId("play").click();
    await expect
      .poll(async () => Number(await page.getByTestId("frames-played").textContent()))
      .toBeGreaterThan(48000);
    await expect(page.getByTestId("underruns")).toHaveText("0");
    const first = Number(await page.getByTestId("frames-played").textContent());
    await analysisCommand(page, "view.split-spectral", "View");
    const canvases = page.locator('[data-testid^="spectrogram-canvas-"]');
    await expect(canvases).toHaveCount(2);
    const progress = await page.evaluate(async () => {
      const probe = window.__aaePlaybackProbe;
      if (!probe) throw new Error("production audio probe missing");
      const header = new Int32Array(probe.ring.sab, 0, 4);
      let paints = 0,
        sawPartial = false,
        maxUnderruns = 0;
      const started = performance.now();
      return await new Promise<{
        paints: number;
        sawPartial: boolean;
        maxUnderruns: number;
        durationMs: number;
      }>((resolve, reject) => {
        const timer = setInterval(() => {
          maxUnderruns = Math.max(maxUnderruns, Atomics.load(header, 2));
          const nodes = Array.from(
            document.querySelectorAll<HTMLElement>('[data-testid^="spectrogram-canvas-"]'),
          );
          for (const node of nodes) {
            const painted = Number(node.dataset.paintedColumns ?? 0),
              total = Number(node.dataset.totalTiles ?? 0),
              complete = Number(node.dataset.completedTiles ?? 0);
            if (painted > 0) {
              paints = Math.max(paints, painted);
              if (complete < total) sawPartial = true;
            }
          }
          if (
            nodes.length === 2 &&
            nodes.every(
              (node) =>
                Number(node.dataset.totalTiles) > 0 &&
                node.dataset.completedTiles === node.dataset.totalTiles,
            )
          ) {
            clearInterval(timer);
            clearTimeout(timeout);
            resolve({ paints, sawPartial, maxUnderruns, durationMs: performance.now() - started });
          }
        }, 20);
        const timeout = setTimeout(() => {
          clearInterval(timer);
          reject(new Error("ten-minute spectrogram did not complete"));
        }, 120000);
      });
    });
    console.info("Ten-minute progressive spectrogram playback", progress);
    await test.info().attach("spectrogram-playback", {
      body: JSON.stringify(progress),
      contentType: "application/json",
    });
    expect(progress.sawPartial).toBe(true);
    expect(progress.paints).toBeGreaterThan(128);
    expect(progress.maxUnderruns).toBe(0);
    expect(Number(await page.getByTestId("frames-played").textContent())).toBeGreaterThan(
      first + 48000,
    );
    await expect(
      page
        .getByRole("region", { name: "Playback output meters" })
        .getByRole("meter", { name: "Channel 1 peak" }),
    ).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.waitForTimeout(1000);
    await expect(page.getByTestId("underruns")).toHaveText("0");
    await page.getByTestId("stop").click();
    await expect(page.getByTestId("underruns")).toHaveText("0");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
