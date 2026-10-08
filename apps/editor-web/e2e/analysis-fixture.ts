/// <reference lib="dom" />

import type { AnalysisJobResult, TimelineResult } from "@aae/protocol";
import { expect, type Page } from "@playwright/test";
import { runCommand } from "./command-fixture.js";
import { info, load, select } from "./edit-fixture.ts";
import { sourceState } from "./export-fixture.ts";
import { revealControl } from "./ui-disclosures.ts";
export async function analysisCommand(page: Page, id: string, menu = "Analyze") {
  await runCommand(page, id, menu);
}
export function sine(frames: number, hz = 440) {
  return Array.from({ length: frames }, (_, frame) =>
    Math.fround(0.5 * Math.sin((2 * Math.PI * hz * frame) / 48000)),
  );
}
export async function statisticsAndClipping(page: Page) {
  await load(page, [
    [0, 1.25, 1.25, 0, -1.25, 0, 0, 0],
    [0, 0.25, -0.25, 0.25, -0.25, 0, 0, 0],
  ]);
  await select(page, 1, 5);
  await (
    await revealControl(
      page.getByRole("button", { name: "Right", exact: true, includeHidden: true }),
    )
  ).click();
  const before = await sourceState(page);
  await analysisCommand(page, "analyze.statistics");
  let dialog = page.getByRole("dialog", { name: "Audio statistics" });
  await expect(dialog.getByRole("table")).toBeVisible();
  await expect(dialog).toContainText("Frames 1–5");
  const cells = await dialog.locator("tbody tr").allTextContents();
  expect(cells).toHaveLength(1);
  expect(cells[0]).toContain("2");
  expect(cells[0]).toContain("-12.0");
  expect(cells[0]).toContain("0.000000");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  expect(await sourceState(page)).toEqual(before);
  await (
    await revealControl(page.getByRole("button", { name: "All", exact: true, includeHidden: true }))
  ).click();
  const selected = await sourceState(page);
  await analysisCommand(page, "analyze.clipping");
  dialog = page.getByRole("dialog", { name: "Detect clipping" });
  await expect(dialog.getByRole("button", { name: "Add clipping markers" })).toBeEnabled();
  await expect(dialog).toContainText("2 clipped regions detected");
  await dialog.getByRole("button", { name: "Add clipping markers" }).click();
  await expect(dialog).not.toBeVisible();
  const after = await sourceState(page);
  expect(after.history.entries).toHaveLength(selected.history.entries.length + 1);
  const markers = await page.evaluate(async () => {
    const doc = (await window.__aaeTest?.request("doc.info")) as { documentId: string };
    if (!window.__aaeTest) throw new Error("kernel probe missing");
    return (
      (await window.__aaeTest.request("timeline.get", {
        documentId: doc.documentId,
      })) as TimelineResult
    ).markers;
  });
  expect(markers).toHaveLength(2);
  await page.getByTestId("document-details").click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect
    .poll(async () => (await sourceState(page)).history.currentStateId)
    .toBe(selected.history.currentStateId);
}
export async function pitchAndSpectrum(page: Page) {
  await load(page, [sine(48000)]);
  const before = await sourceState(page);
  await analysisCommand(page, "analyze.pitch");
  const dialog = page.getByRole("dialog", { name: "Pitch tracking" });
  await expect(dialog.getByTestId("pitch-track-path")).toHaveAttribute("d", /^M/);
  await dialog.getByText(/Pitch measurements/).click();
  const frequencies = await dialog.locator("tbody tr td:nth-child(3)").allTextContents();
  expect(frequencies.length).toBeGreaterThan(0);
  expect(frequencies.every((value) => Math.abs(Number(value) - 440) < 2)).toBe(true);
  await dialog.getByRole("button", { name: "Close analysis" }).click();
  await analysisCommand(page, "analyze.spectrum");
  const panel = page.getByRole("region", { name: "Spectrum analyzer" });
  await expect(panel.getByTestId("spectrum-path")).toHaveAttribute("d", /^M/);
  await panel.getByLabel("FFT size", { exact: true }).selectOption("4096");
  await panel.getByLabel("Window", { exact: true }).selectOption("blackman");
  await panel.getByLabel("Averaging", { exact: true }).selectOption("4");
  await panel.getByLabel("Octave smoothing", { exact: true }).selectOption("6");
  await expect(panel.getByTestId("spectrum-path")).toHaveAttribute("d", /^M/);
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await panel.getByRole("button", { name: "Close spectrum" }).click();
  expect(await sourceState(page)).toEqual(before);
  const doc = await info(page);
  const spectrum = await page.evaluate(async (doc) => {
    let job = (await window.__aaeTest?.request("analysis.start", {
      documentId: doc.documentId,
      start: 0,
      end: doc.frames,
      channelMask: 1,
      kind: "spectrum",
      fftSize: 4096,
      averaging: 4,
    })) as AnalysisJobResult;
    while (job.state === "running")
      job = (await window.__aaeTest?.request("analysis.step", {
        documentId: doc.documentId,
        jobId: job.jobId,
      })) as AnalysisJobResult;
    await window.__aaeTest?.request("analysis.cancel", {
      documentId: doc.documentId,
      jobId: job.jobId,
    });
    if (!job.data || !job.bins) throw new Error("spectrum binary missing");
    const data = new Float64Array(job.data);
    let maximum = -Infinity,
      frequency = 0;
    for (let bin = 1; bin < job.bins; bin++)
      if (data[bin * 2 + 1] > maximum) {
        maximum = data[bin * 2 + 1];
        frequency = data[bin * 2];
      }
    return frequency;
  }, doc);
  expect(Math.abs(spectrum - 440)).toBeLessThan(48000 / 4096);
}
