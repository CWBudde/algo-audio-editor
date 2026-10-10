import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ElectronApplication, expect, test } from "@playwright/test";
import { closeEditor, launchEditor, menuCommand } from "./launch.js";

async function preferences(app: ElectronApplication) {
  const page = await app.firstWindow();
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
  await menuCommand(app, "edit.preferences");
  const dialog = page.getByRole("dialog", { name: "Preferences" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("native Edit → Preferences persists across an application restart", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "aae-desktop-preferences-"));
  const args = [path.join(__dirname, "..")];
  try {
    let app = await launchEditor({ args }, { userData });
    try {
      const dialog = await preferences(app);
      await dialog.getByLabel("Default export format").selectOption("aiff");
      await dialog.getByLabel("Default dither").selectOption("gaussian");
      await dialog.getByLabel("Time format").selectOption("hms");
      await dialog.getByLabel("Snap to ruler ticks").check();
      await dialog.getByRole("button", { name: "Close" }).click();
      await expect(dialog).not.toBeVisible();
      // A normal quit flushes DOM storage; closeEditor exits abruptly instead.
      await app.evaluate(({ session }) => session.defaultSession.flushStorageData());
    } finally {
      await closeEditor(app);
    }

    app = await launchEditor({ args }, { userData });
    try {
      const dialog = await preferences(app);
      await expect(dialog.getByLabel("Default export format")).toHaveValue("aiff");
      await expect(dialog.getByLabel("Default dither")).toHaveValue("gaussian");
      await expect(dialog.getByLabel("Time format")).toHaveValue("hms");
      await expect(dialog.getByLabel("Snap to ruler ticks")).toBeChecked();
      await expect(dialog.getByLabel("Snap to zero crossings")).not.toBeChecked();
    } finally {
      await closeEditor(app);
    }
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});
