import { expect, type Page, test } from "@playwright/test";
import { runCommand } from "./command-fixture.ts";
import { load } from "./edit-fixture.ts";
import { openExport } from "./export-fixture.ts";
import { captureKernelWorker } from "./kernel-probe.ts";

async function ready(page: Page) {
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
}

test.beforeEach(async ({ page }) => {
  await captureKernelWorker(page);
  await page.goto("/");
  await ready(page);
});

test("Preferences persist across reloads and set the waveform and export defaults", async ({
  page,
}) => {
  await runCommand(page, "edit.preferences", "Edit");
  let dialog = page.getByRole("dialog", { name: "Preferences" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Default export format")).toBeFocused();
  await dialog.getByLabel("Default export format").selectOption("flac");
  await dialog.getByLabel("Default dither").selectOption("none");
  await dialog.getByLabel("Time format").selectOption("samples");
  await dialog.getByLabel("Snap to zero crossings").check();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();

  await page.reload();
  await ready(page);
  await page.keyboard.press("ControlOrMeta+Comma");
  dialog = page.getByRole("dialog", { name: "Preferences" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Default export format")).toHaveValue("flac");
  await expect(dialog.getByLabel("Default dither")).toHaveValue("none");
  await expect(dialog.getByLabel("Time format")).toHaveValue("samples");
  await expect(dialog.getByLabel("Snap to zero crossings")).toBeChecked();
  await dialog.getByRole("button", { name: "Close" }).click();

  // The waveform's own controls show, and edit, the same stored values.
  await load(page);
  await expect(page.locator('select[aria-label="Time format"]')).toHaveValue("samples");
  await expect(
    page.getByRole("checkbox", { name: "Zero crossings", includeHidden: true }),
  ).toBeChecked();
  const exporting = await openExport(page);
  await expect(exporting.getByLabel("Format", { exact: true })).toHaveValue("flac");
  await expect(exporting.getByLabel("Dither", { exact: true })).toHaveValue("none");
});
