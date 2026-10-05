/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
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
  for (const action of ["Cut", "Copy", "Zoom in", "Zoom out", "Zoom to fit"]) {
    await expect(page.getByRole("button", { name: action, exact: true })).toBeInViewport();
  }
  await page.screenshot({ path: testInfo.outputPath("editor-narrow.png") });
  expect(fontRequests).toEqual([]);
  expect(await page.evaluate(() => document.fonts.size)).toBe(0);
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
