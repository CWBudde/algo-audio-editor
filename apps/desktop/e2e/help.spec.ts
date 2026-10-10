import path from "node:path";
import { expect, test } from "@playwright/test";
import { closeEditor, menuCommand as command, launchEditor } from "./launch.js";

test("native Help menu lists shortcuts and copies diagnostics through the main process", async () => {
  const app = await launchEditor({ args: [path.join(__dirname, "..")] });
  try {
    const page = await app.firstWindow();
    await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
    // Capture the main-process clipboard write instead of replacing the user's clipboard.
    await app.evaluate(({ clipboard }) => {
      const scope = globalThis as unknown as { __copied: string[] };
      scope.__copied = [];
      clipboard.writeText = async (text: string) => {
        scope.__copied.push(text);
      };
    });

    await command(app, "help.shortcuts");
    const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(dialog).toBeVisible();
    const mod = process.platform === "darwin" ? "Cmd" : "Ctrl";
    await expect(dialog.getByTestId("shortcut-edit.undo")).toContainText(`${mod}+Z`);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();

    await command(app, "help.diagnostics");
    await expect(page.getByText("Diagnostics copied to the clipboard")).toBeVisible();
    const copied = await app.evaluate(
      () => (globalThis as unknown as { __copied: string[] }).__copied,
    );
    expect(copied).toHaveLength(1);
    const lines = copied[0].split("\n");
    expect(lines).toContain("Kernel status: ready");
    expect(lines).toContain("Isolated: yes");
    expect(lines.find((line) => line.startsWith("Platform: "))).toMatch(/^Platform: Electron \d/);
  } finally {
    await closeEditor(app);
  }
});
