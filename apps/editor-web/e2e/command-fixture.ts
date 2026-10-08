import { expect, type Page } from "@playwright/test";

/** Shared UI scenarios exercise the palette when Electron owns the menu. */
export async function commandItem(page: Page, id: string, menu: string) {
  if (
    await page.evaluate(() => Boolean((window as Window & { aaeDesktop?: unknown }).aaeDesktop))
  ) {
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    return palette.locator(`[role="option"][data-command-id="${id}"]`);
  }
  await page.getByRole("menuitem", { name: menu, exact: true }).click();
  return page.locator(`[role="menuitem"][data-command-id="${id}"]`);
}
export async function runCommand(page: Page, id: string, menu: string) {
  await (await commandItem(page, id, menu)).click();
}
