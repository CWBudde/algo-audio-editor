/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import { PROTOCOL_VERSION } from "../../../packages/protocol/src/index.ts";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
});

test("Help lists the registered keyboard shortcuts with this platform's keys", async ({ page }) => {
  const mac = await page.evaluate(() => /Mac/i.test(navigator.platform));
  const mod = mac ? "Cmd" : "Ctrl";
  const help = page.getByRole("menuitem", { name: "Help", exact: true });
  await help.click();
  await page.getByRole("menuitem", { name: "Keyboard shortcuts…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("shortcut-edit.undo")).toContainText(`Undo${mod}+Z`);
  await expect(dialog.getByTestId("shortcut-edit.redo").getByTestId("shortcut-key")).toHaveText(
    mac ? ["Cmd+Shift+Z"] : ["Ctrl+Shift+Z", "Ctrl+Y"],
  );
  await expect(dialog.getByTestId("shortcut-transport.toggle-playback")).toContainText("Space");
  await expect(dialog.getByRole("region", { name: "Help" })).toContainText(`${mod}+K`);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(help).toBeFocused();
});

test("Help copies the About diagnostics as plain text", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("menuitem", { name: "Help", exact: true }).click();
  await page.getByRole("menuitem", { name: "Copy diagnostics", exact: true }).click();
  await expect(page.getByText("Diagnostics copied to the clipboard")).toBeVisible();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  const lines = text.split("\n");
  expect(lines[0]).toBe("algo-audio-editor diagnostics");
  expect(lines).toContain("Kernel status: ready");
  expect(lines).toContain(`Protocol: ABI v${PROTOCOL_VERSION}`);
  expect(lines).toContain("Isolated: yes");
  expect(lines).toContain("Platform: Browser");
  expect(lines.find((line) => line.startsWith("Kernel: "))).toContain("go1.");
});
