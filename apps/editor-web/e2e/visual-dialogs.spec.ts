/// <reference lib="dom" />
import { expect, type Locator, type Page, test } from "@playwright/test";
import { runCommand } from "./command-fixture.ts";
import { sourceState } from "./export-fixture.ts";
import { captureKernelWorker } from "./kernel-probe.ts";
import { playbackWAV } from "./playback-fixture.ts";
import { revealControl } from "./ui-disclosures.ts";

async function command(page: Page, id: string, query: string) {
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("combobox").fill(query);
  await palette.locator(`[data-command-id="${id}"]`).click();
  await expect(palette).not.toBeVisible();
}

test("long annotation names and draft actions remain reachable in a narrow popup", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 480, height: 600 });
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
  await page.getByTestId("audio-file-input").setInputFiles({
    name: "annotations.wav",
    mimeType: "audio/wav",
    buffer: playbackWAV(24000),
  });
  await expect(page.getByTestId("waveform-channel-0")).toHaveAttribute("data-rendered", "true");
  const name = `${"LongUnbrokenAnnotation".repeat(8)}🎵`;
  await (await revealControl(page.getByLabel("Marker or region name"))).fill(name);
  await page.getByRole("button", { name: "Add marker", exact: true }).click();
  const details = page.getByTestId("timeline-panel");
  await details.locator("summary").click();
  const panel = details.locator("[data-disclosure-panel]");
  await expect(panel.getByText(name, { exact: true })).toBeVisible();
  await expect(
    panel.getByRole("button", { name: `Edit marker ${name}`, exact: true }),
  ).toBeVisible();
  expect(
    await panel.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  await panel.getByRole("button", { name: `Edit marker ${name}`, exact: true }).click();
  await panel.getByLabel("Timeline name", { exact: true }).fill("Renamed annotation 🎵");
  const save = panel.getByRole("button", { name: "Save marker", exact: true });
  await save.focus();
  await expect(save).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("annotation-draft-narrow.png") });
  await save.click();
  await expect(panel.getByText("Renamed annotation 🎵", { exact: true })).toBeVisible();
  await panel
    .getByRole("button", { name: "Jump to marker Renamed annotation 🎵", exact: true })
    .focus();
  await page.keyboard.press("Escape");
  await expect(panel).not.toBeVisible();
  await expect(details.locator("summary")).toBeFocused();
  await expect(page.locator("footer")).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(480);
});

test("smallest workspace keeps menu labels and meter readouts inside their panels", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
  await page.getByTestId("audio-file-input").setInputFiles({
    name: "small-screen.wav",
    mimeType: "audio/wav",
    buffer: playbackWAV(48000 * 12),
  });
  await expect(page.getByTestId("waveform-channel-0")).toHaveAttribute("data-rendered", "true");
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const menuBounds = await menu.boundingBox();
  if (!menuBounds) throw new Error("Edit menu bounds missing");
  expect(menuBounds.x).toBeGreaterThanOrEqual(0);
  expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(320);
  for (const item of await menu.getByRole("menuitem").all()) {
    expect(await item.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(
      await item
        .locator("span")
        .first()
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
  }
  await page.screenshot({ path: testInfo.outputPath("edit-menu-small.png") });
  await page.keyboard.press("Escape");
  await runCommand(page, "analyze.meters", "Analyze");
  const meters = page.getByRole("region", { name: "Playback output meters" });
  await page.getByTestId("play").click();
  await expect(meters.getByRole("meter", { name: "Channel 1 peak" })).toHaveAttribute(
    "aria-valuenow",
    /-6\./,
  );
  await meters.scrollIntoViewIfNeeded();
  expect(await meters.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  for (const cell of await meters.locator(".analysis-channel-levels dd").all())
    expect(await cell.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const close = meters.getByRole("button", { name: "Close meters", exact: true });
  await close.focus();
  await expect(close).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("meters-small.png") });
  await close.click();
  await page.getByTestId("stop").click();
  await expect(page.locator("footer")).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

async function bounded(dialog: Locator, width: number, height: number) {
  await expect(dialog).toBeVisible();
  const geometry = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: rect.x,
      y: rect.y,
      right: rect.right,
      bottom: rect.bottom,
      overflow: element.scrollWidth - element.clientWidth,
    };
  });
  expect(geometry.x).toBeGreaterThanOrEqual(15);
  expect(geometry.y).toBeGreaterThanOrEqual(15);
  expect(geometry.right).toBeLessThanOrEqual(width - 15);
  expect(geometry.bottom).toBeLessThanOrEqual(height - 15);
  expect(geometry.overflow).toBeLessThanOrEqual(1);
}

for (const width of [480, 960]) {
  test(`populated and warning dialogs keep fields and actions accessible at ${width}×600`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 600 });
    await captureKernelWorker(page);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
    await page.getByTestId("audio-file-input").setInputFiles({
      name: `${"SessionRecording".repeat(12)}🎵.wav`,
      mimeType: "audio/wav",
      buffer: playbackWAV(24000),
    });
    await expect(page.getByTestId("waveform-channel-0")).toHaveAttribute("data-rendered", "true");
    const before = await sourceState(page);

    await command(page, "file.metadata", "File metadata");
    const metadata = page.getByRole("dialog", { name: "File metadata" });
    await metadata.getByLabel("Title", { exact: true }).fill("A populated title 🎵");
    await metadata.getByLabel("Artist", { exact: true }).fill("Studio session");
    await bounded(metadata, width, 600);
    const applyMetadata = metadata.getByRole("button", { name: "Apply metadata" });
    await applyMetadata.focus();
    await expect(applyMetadata).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("metadata-short.png") });
    await page.keyboard.press("Escape");
    await expect(metadata).not.toBeVisible();

    await command(page, "process.amplify", "Amplify");
    const process = page.getByRole("dialog", { name: "Amplify", exact: true });
    await process.getByLabel("Gain (dB)", { exact: true }).fill("24");
    await process.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(process.getByRole("alert")).toContainText("exceeds full scale");
    await bounded(process, width, 600);
    const cancel = process.getByRole("button", { name: "Cancel", exact: true });
    await cancel.focus();
    await expect(cancel).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("processing-warning-short.png") });
    await page.keyboard.press("Escape");
    await expect(process).not.toBeVisible();

    await command(page, "file.export", "Export audio");
    const exporting = page.getByRole("dialog", { name: "Export audio" });
    await expect(exporting.getByRole("button", { name: "Export", exact: true })).toBeEnabled();
    await bounded(exporting, width, 600);
    const exportAction = exporting.getByRole("button", { name: "Export", exact: true });
    await exportAction.focus();
    await expect(exportAction).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("export-short.png") });
    await page.keyboard.press("Escape");
    await expect(exporting).not.toBeVisible();

    expect(await sourceState(page)).toEqual(before);
    await expect(page.locator("footer")).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    expect(errors).toEqual([]);
  });
}
