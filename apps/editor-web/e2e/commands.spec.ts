/// <reference lib="dom" />

import { expect, type Page, test } from "@playwright/test";
import { info, LEFT, load, RIGHT, samples, select } from "./edit-fixture.ts";
import { captureKernelWorker } from "./kernel-probe.ts";
import { revealControl } from "./ui-disclosures.ts";

async function palette(page: Page, query: string) {
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await expect(dialog).toBeVisible();
  const search = dialog.getByRole("combobox", { name: "Search commands" });
  await expect(search).toBeFocused();
  await search.fill(query);
  return { dialog, search };
}

test.beforeEach(async ({ page }) => {
  await captureKernelWorker(page);
  await page.addInitScript(() => Object.assign(window, { showSaveFilePicker: undefined }));
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
});

test("palette discovers disabled commands without a document, restores focus and toggles", async ({
  page,
}) => {
  const opener = page.getByRole("menuitem", { name: "File", exact: true });
  await opener.focus();
  const { dialog, search } = await palette(page, "normalize");
  await expect(dialog.locator('[data-command-id="process.normalize"]')).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await search.press("Enter");
  await expect(dialog).toBeVisible();
  await search.fill("not-a-command");
  await expect(dialog.getByRole("status")).toHaveText("No matching commands.");
  await search.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(opener).toBeFocused();
  await palette(page, "");
  await page.keyboard.press("Control+k");
  await expect(dialog).not.toBeVisible();
});

test("palette and menu edit the real kernel, while export keeps the working document dirty", async ({
  page,
}) => {
  await load(page);
  await select(page, 2, 6);
  const initial = (await info(page)).documentId;
  let opened = await palette(page, "mute");
  await opened.search.press("Enter");
  await expect(opened.dialog).not.toBeVisible();
  await expect.poll(async () => (await info(page)).documentId).not.toBe(initial);
  expect(await samples(page)).toEqual([
    LEFT.map((n, i) => (i >= 2 && i < 6 ? 0 : n)),
    RIGHT.map((n, i) => (i >= 2 && i < 6 ? 0 : n)),
  ]);
  await expect(page.getByTestId("history-dirty")).toHaveText("Unsaved changes");
  opened = await palette(page, "export wav");
  const downloading = page.waitForEvent("download");
  await opened.search.press("Enter");
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("edit-48000.wav");
  await expect(page.getByTestId("history-dirty")).toHaveText("Unsaved changes");
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  await page.locator('[role="menuitem"][data-command-id="edit.undo"]').click();
  await expect.poll(async () => (await info(page)).documentId).not.toBe(initial);
  await expect.poll(async () => await samples(page)).toEqual([LEFT, RIGHT]);
});

test("select-all and silence palette commands use the live channel mask and exact toolbar draft", async ({
  page,
}) => {
  await load(page);
  await (
    await revealControl(
      page.getByRole("button", { name: "Right", exact: true, includeHidden: true }),
    )
  ).click();
  const silence = await revealControl(page.getByLabel("Silence frames", { exact: true }));
  await silence.fill("3");
  await silence.press("Control+a");
  await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-selection-end", "0");
  await page.getByTestId("document-details").click();
  await page.keyboard.press("Control+a");
  await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-selection-end", "8");
  await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-channel-mask", "2");
  const { search } = await palette(page, "insert silence");
  await search.press("Enter");
  await expect(page.getByTestId("document-details")).toContainText("· 11 frames");
  expect(await samples(page)).toEqual([
    [...LEFT, 0, 0, 0],
    [0, 0, 0, ...RIGHT],
  ]);
});

test("committing a pointer preview re-enables menu commands without changing coordinates", async ({
  page,
}) => {
  await load(page);
  const bounds = await page.getByTestId("waveform-channel-0").boundingBox();
  if (!bounds) throw new Error("waveform bounds missing");
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(bounds.x + bounds.width * 0.25, y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.75, y);
  await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-selection-start", "2");
  await expect(page.getByTestId("waveform-view")).toHaveAttribute("data-selection-end", "6");
  await page.mouse.up();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  const copy = page.locator('[role="menuitem"][data-command-id="edit.copy"]');
  await expect(copy).toBeEnabled();
  await copy.click();
  await expect(page.getByRole("button", { name: "Paste", exact: true })).toBeEnabled();
});

test("macOS displays and executes Cmd shortcuts, preserving the other modifier", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "platform", { value: "MacIntel" }),
  );
  await page.reload();
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Command palette" })).not.toBeVisible();
  await page.keyboard.press("Meta+k");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-command-id="file.save"]')).toContainText("Cmd+S");
  await page.keyboard.press("Meta+k");
  await expect(dialog).not.toBeVisible();
});
