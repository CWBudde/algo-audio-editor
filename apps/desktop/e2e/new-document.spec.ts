import path from "node:path";
import { expect, test } from "@playwright/test";
import { closeEditor, launchEditor, menuCommand } from "./launch.js";

test("native File → New creates clean silence in the chosen format", async () => {
  const app = await launchEditor({ args: [path.join(__dirname, "..")] });
  try {
    const page = await app.firstWindow();
    await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
    await menuCommand(app, "file.new");
    const dialog = page.getByRole("dialog", { name: "New document" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Sample rate").selectOption("96000");
    await dialog.getByLabel("Channels").selectOption("6");
    await dialog.getByLabel("Length (seconds)").fill("0.5");
    await dialog.getByRole("button", { name: "Create" }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByTestId("document-name")).toHaveText("Untitled");
    await expect(page.getByTestId("document-details")).toContainText(
      "96000 Hz · 6 channels · 48000 frames · 0.500 s · 32-bit float",
    );
    await expect(page.getByTestId("document-save-status")).toHaveText("Saved");
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isDocumentEdited(),
      ),
    ).toBe(false);
  } finally {
    await closeEditor(app);
  }
});
