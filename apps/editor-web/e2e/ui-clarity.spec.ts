/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import { captureKernelWorker } from "./kernel-probe.ts";
import { playbackWAV } from "./playback-fixture.ts";

test("uses system fonts without downloads and keeps desktop and narrow editor controls compact", async ({
  page,
}, testInfo) => {
  const fontRequests: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "font") fontRequests.push(request.url());
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
  await expect(page.locator("html")).toHaveCSS(
    "font-family",
    /system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif/,
  );
  const name = `${"Long filename 🎵 — ".repeat(12)}stereo.wav`;
  await page.getByTestId("audio-file-input").setInputFiles({
    name,
    mimeType: "audio/wav",
    buffer: playbackWAV(24000),
  });
  await expect(page.getByTestId("waveform-channel-1")).toHaveAttribute("data-rendered", "true");
  const footer = page.locator("footer");
  await expect(footer.getByTestId("document-name")).toHaveText(name);
  await expect(page.getByTestId("waveform-view").getByTestId("document-name")).toHaveCount(0);
  await expect(footer.getByTestId("document-details")).toContainText(
    "48000 Hz · 2 channels · 24000 frames",
  );
  await expect(footer).not.toContainText(/kernel ready|Underruns|Platform/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1920);
  await expect(footer).toBeInViewport();
  await expect(page.getByLabel("Time format", { exact: true })).not.toBeVisible();
  await expect(page.getByLabel("Channel 1 selected", { exact: true })).not.toBeVisible();
  await expect(page.getByLabel("Marker or region name", { exact: true })).not.toBeVisible();
  const ruler = await page.getByTestId("waveform-time-ruler").boundingBox();
  expect(ruler?.y).toBeLessThanOrEqual(160);
  const toolbar = page.getByTestId("primary-controls");
  expect((await toolbar.boundingBox())?.height).toBeLessThanOrEqual(40);
  for (const label of ["Selection start", "Selection end", "Selection length"]) {
    await expect(toolbar.getByLabel(label, { exact: true })).toBeVisible();
    await expect(
      toolbar.getByLabel(label, { exact: true }).locator("..").locator("span").last(),
    ).toHaveText("s");
  }
  for (const group of ["Zoom", "Display and snapping", "Annotations"])
    await expect(toolbar.getByRole("group", { name: group, exact: true })).toBeVisible();
  await expect(toolbar.getByTestId("channel-settings").locator("summary")).toBeVisible();
  const main = await page.locator("main").boundingBox();
  const workspace = await page.getByTestId("waveform-view").boundingBox();
  const toolbarBox = await toolbar.boundingBox();
  if (!main || !workspace || !toolbarBox) throw new Error("Editor geometry missing");
  expect(workspace).toEqual(main);
  expect(workspace.x).toBe(0);
  expect(workspace.width).toBe(1920);
  expect(workspace.y).toBe(toolbarBox.y + toolbarBox.height);
  for (const action of [
    "Cut",
    "Copy",
    "Paste",
    "Zoom in",
    "Zoom out",
    "Zoom to fit",
    "Zoom to selection",
  ]) {
    const button = page.getByRole("button", { name: action, exact: true });
    await expect(button).toBeVisible();
    await expect(button.locator("svg")).toHaveCount(1);
    expect((await button.innerText()).trim()).toBe("");
  }
  await page.screenshot({ path: testInfo.outputPath("editor-desktop.png") });
  await page.setViewportSize({ width: 640, height: 720 });
  await expect(page.getByTestId("waveform-channel-0")).toHaveAttribute("data-rendered", "true");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(640);
  await expect(footer.getByTestId("document-name")).toBeVisible();
  // Bands share the transport toolbar; each group wraps as a unit instead of
  // breaking its icons or field label/value/unit across rows.
  for (const width of [1280, 960, 640, 480, 320]) {
    await page.setViewportSize({ width, height: 720 });
    await expect(page.locator("footer")).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    const bands = await toolbar.locator(".editor-tool-band").evaluateAll((elements) =>
      elements.map((element) => {
        const bounds = element.getBoundingClientRect();
        const children = Array.from(element.children).filter((child) => child.checkVisibility());
        return {
          left: bounds.left,
          right: bounds.right,
          height: bounds.height,
          centers: children.map((child) => {
            const box = child.getBoundingClientRect();
            return box.y + box.height / 2;
          }),
        };
      }),
    );
    for (const band of bands) {
      expect(band.left).toBeGreaterThanOrEqual(0);
      expect(band.right).toBeLessThanOrEqual(width);
      expect(band.height).toBeLessThanOrEqual(32);
      if (band.centers.length > 1)
        expect(Math.max(...band.centers) - Math.min(...band.centers)).toBeLessThanOrEqual(4);
    }
  }
  await page.setViewportSize({ width: 640, height: 720 });
  for (const action of ["Cut", "Copy", "Zoom in", "Zoom out", "Zoom to fit"]) {
    await expect(page.getByRole("button", { name: action, exact: true })).toBeInViewport();
  }
  await page.screenshot({ path: testInfo.outputPath("editor-narrow.png") });
  expect(fontRequests).toEqual([]);
  expect(await page.evaluate(() => document.fonts.size)).toBe(0);
});

test("waveform fills the workspace and repaints a height-only resize without refetching peaks", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await captureKernelWorker(page);
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
  await page.getByRole("button", { name: "Open demo", exact: true }).click();
  const canvas = page.getByTestId("waveform-channel-0");
  await expect(canvas).toHaveAttribute("data-rendered", "true");
  await expect(page.getByTestId("waveform-channel-1")).toHaveAttribute("data-rendered", "true");
  await expect(page.getByTestId("waveform-overview")).toHaveAttribute("data-rendered", "true");
  const before = await canvas.boundingBox();
  if (!before) throw new Error("waveform bounds missing");
  expect(before.height).toBeGreaterThan(280);
  await expect(page.getByTestId("waveform-channel-1")).toBeInViewport();
  await expect(page.getByTestId("waveform-overview")).toBeInViewport();
  await expect(page.locator("footer")).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("workspace-full-hd.png") });
  const calls = await page.evaluate(() => window.__aaeTest?.peakCalls?.length);
  await page.setViewportSize({ width: 1920, height: 720 });
  await expect.poll(async () => (await canvas.boundingBox())?.height).toBeLessThan(before.height);
  await expect
    .poll(async () =>
      canvas.evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        return (
          canvas.height === Math.round(canvas.getBoundingClientRect().height * devicePixelRatio)
        );
      }),
    )
    .toBe(true);
  await expect(canvas).toHaveAttribute("data-rendered", "true");
  expect(await page.evaluate(() => window.__aaeTest?.peakCalls?.length)).toBe(calls);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1920);
  await expect(page.getByTestId("waveform-overview")).toBeInViewport();
  await expect(page.locator("footer")).toBeInViewport();
  await page.setViewportSize({ width: 640, height: 720 });
  await expect(canvas).toHaveAttribute("data-rendered", "true");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(640);
  await page.screenshot({ path: testInfo.outputPath("workspace-narrow.png") });
});

test("information is on demand and does not stop playback or let editor shortcuts escape", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
  await page.getByTestId("audio-file-input").setInputFiles({
    name: "status-playback.wav",
    mimeType: "audio/wav",
    buffer: playbackWAV(48000 * 12),
  });
  await expect(page.getByTestId("play")).toBeEnabled();
  await page.getByTestId("play").click();
  const information = page.getByRole("button", { name: "Information", exact: true });
  await information.click();
  const dialog = page.getByRole("dialog", { name: "About / Status", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("platform")).toHaveText("Browser");
  await expect(dialog.getByTestId("cross-origin-isolated")).toHaveText("yes");
  const before = Number(await dialog.getByTestId("frames-played").textContent());
  const range = await page.getByTestId("waveform-view").getAttribute("data-start-frame");
  // Space on the focused Close button legitimately activates it. Test the
  // editor-shortcut fence from a non-actionable area of the modal instead.
  await dialog.locator("dl").evaluate((element) => {
    element.tabIndex = -1;
    element.focus();
  });
  await page.keyboard.press("Space");
  await page.keyboard.press("Control+=");
  await expect
    .poll(async () => Number(await dialog.getByTestId("frames-played").textContent()))
    .toBeGreaterThan(before);
  await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-start-frame", range ?? "0");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(information).toBeFocused();
  await page.getByTestId("stop").click();
  await expect(page.getByTestId("underruns")).toHaveText("0");
});
