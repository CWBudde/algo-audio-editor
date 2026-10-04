import { expect, test } from "@playwright/test";
import { info, load, samples, select } from "./edit-fixture.ts";
import { captureKernelWorker } from "./kernel-probe.ts";
import { capturePlayback } from "./playback-probe.ts";
import {
  applyRestoration,
  restorationCommand,
  restorationTone,
  spectralClickRepair,
  stretchInShell,
} from "./restoration-fixture.ts";

test.beforeEach(async ({ page }) => {
  await captureKernelWorker(page);
  await capturePlayback(page);
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
});
test("rectangle healing repairs a reference click and keeps the other channel and undo exact", async ({
  page,
}) => {
  await spectralClickRepair(page);
});
test("lasso preview uses a private candidate and Cancel retains source and focus", async ({
  page,
}) => {
  const tone = restorationTone(48000);
  await load(page, [tone]);
  const before = await info(page);
  await restorationCommand(page, "view.spectrogram", "View");
  await page.getByLabel("Spectrogram selection tool").selectOption("lasso");
  const layer = page.getByTestId("spectral-selection-0"),
    box = await layer.boundingBox();
  if (!box) throw new Error("No selection layer");
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.95);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.9);
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.95);
  await page.mouse.up();
  const opener = page.getByRole("button", { name: "Attenuate…", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Attenuate spectral selection" });
  await expect(dialog).toContainText("lasso");
  await dialog.getByLabel("Gain (dB)").fill("-24");
  await dialog.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(dialog.getByTestId("process-status")).toContainText("Previewing");
  expect(await info(page)).toEqual(before);
  expect(await samples(page)).toEqual([tone]);
  await expect(page.getByTestId("underruns")).toHaveText("0");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(opener).toBeFocused();
  expect(await samples(page)).toEqual([tone]);
  await layer.focus();
  await page.keyboard.press("Escape");
  await expect(layer).not.toHaveAttribute("data-start-frame");
});
test("default profiled reduction exceeds 15 dB and rejects the profile after editing", async ({
  page,
}) => {
  let seed = 1234567;
  const random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return (seed + 1) / 4294967297;
  };
  const noise = Array.from({ length: 96000 }, () =>
    Math.fround(0.02 * Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random())),
  );
  await load(page, [noise]);
  await select(page, 0, 24000);
  await restorationCommand(page, "process.capture-noise-profile");
  await select(page, 24000, 96000);
  await applyRestoration(page, "noise-reduce");
  const out = (await samples(page))[0];
  expect(out.slice(0, 24000)).toEqual(noise.slice(0, 24000));
  let before = 0,
    after = 0;
  for (let i = 24000; i < noise.length; i++) {
    before += noise[i] ** 2;
    after += out[i] ** 2;
  }
  expect(10 * Math.log10(before / after)).toBeGreaterThanOrEqual(15);
  await page.getByRole("menuitem", { name: "Restore", exact: true }).click();
  await expect(
    page.locator('[role="menuitem"][data-command-id="process.noise-reduce"]'),
  ).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
});
test("automatic click and clip repair improve damaged fixtures and retain exact undo", async ({
  page,
}) => {
  const clean = restorationTone(12000),
    clicked = [...clean];
  clicked[6000] += 0.8;
  await load(page, [clicked]);
  const original = await samples(page);
  await applyRestoration(page, "remove-clicks");
  const clickedOut = (await samples(page))[0];
  expect(Math.abs(clickedOut[6000] - clean[6000])).toBeLessThan(1e-4);
  await page.getByTestId("document-details").click();
  await page.keyboard.press("Control+z");
  await expect.poll(() => samples(page)).toEqual(original);
  const clipped = clean.map((x) => Math.max(-0.25, Math.min(0.25, x)));
  await load(page, [clipped]);
  await applyRestoration(page, "declip", { "Clipping threshold (linear)": "0.25" });
  const out = (await samples(page))[0];
  let before = 0,
    after = 0;
  for (let i = 200; i < clean.length - 200; i++) {
    before += (clipped[i] - clean[i]) ** 2;
    after += (out[i] - clean[i]) ** 2;
  }
  expect(after).toBeLessThan(before * 0.1);
});
test("time stretch retains pitch and stereo phase through apply and undo", async ({ page }) => {
  await stretchInShell(page);
});
test("mains hum removal suppresses the comb while preserving wanted audio", async ({ page }) => {
  const mixed = Array.from({ length: 144000 }, (_, i) =>
    Math.fround(
      0.2 * Math.sin((2 * Math.PI * 1500 * i) / 48000) +
        0.04 * Math.sin((2 * Math.PI * 50 * i) / 48000) +
        0.03 * Math.sin((2 * Math.PI * 100 * i) / 48000),
    ),
  );
  await load(page, [mixed]);
  await applyRestoration(page, "remove-hum");
  const out = (await samples(page))[0];
  const amplitude = (hz: number) =>
    (Math.abs(
      out
        .slice(96000)
        .reduce((sum, x, i) => sum + x * Math.sin((2 * Math.PI * hz * (i + 96000)) / 48000), 0),
    ) *
      2) /
    48000;
  expect(amplitude(50)).toBeLessThan(0.0002);
  expect(amplitude(100)).toBeLessThan(0.0002);
  expect(amplitude(1500)).toBeGreaterThan(0.19);
});
