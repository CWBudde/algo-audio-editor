import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  analysisCommand,
  pitchAndSpectrum,
  statisticsAndClipping,
} from "../../editor-web/e2e/analysis-fixture.js";
import { captureKernelWorker } from "../../editor-web/e2e/kernel-probe.js";
import { closeEditor, launchEditor } from "./launch.js";

test("Electron analysis uses the actual kernel for selected statistics, clipping history, pitch and progressive spectrogram", async () => {
  test.setTimeout(60000);
  const app = await launchEditor({
    args: [path.join(__dirname, ".."), "--autoplay-policy=no-user-gesture-required"],
  });
  try {
    const page = await app.firstWindow();
    await captureKernelWorker(page);
    await page.reload();
    await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
    await statisticsAndClipping(page);
    await pitchAndSpectrum(page);
    await analysisCommand(page, "view.spectrogram", "View");
    const canvas = page.getByTestId("spectrogram-canvas-0");
    await expect
      .poll(async () => Number(await canvas.getAttribute("data-painted-columns")))
      .toBeGreaterThan(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    await closeEditor(app);
  }
});
