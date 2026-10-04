import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { fixture } from "../../editor-web/e2e/edit-fixture.js";
import { closeEditor, launchEditor } from "./launch.js";

// Exercise real updater/quit wiring with a deterministic feed and installer.
// Download bytes, platform signatures and actual installer execution are release acceptance.
test("update restart respects cancelled close and installs only after a successful save", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aae-update-"));
  const marker = path.join(directory, "installed.txt"),
    output = path.join(directory, "saved.wav");
  const app = await launchEditor({ args: [path.join(__dirname, "..")] });
  try {
    const page = await app.firstWindow();
    await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
    await page.getByTestId("audio-file-input").setInputFiles({
      name: "update.wav",
      mimeType: "audio/wav",
      buffer: fixture([[0, 0.5, -0.5, 0]]),
    });
    await expect(page.getByTestId("document-name")).toHaveText("update.wav");
    await page.getByRole("button", { name: "Add marker", exact: true }).click();
    await expect(page.getByTestId("history-dirty")).toHaveText("Unsaved changes");
    await app.evaluate(
      ({ app, dialog }, { marker, output }) => {
        const require = process
          .getBuiltinModule("module")
          .createRequire(`${app.getAppPath()}/package.json`);
        const updater = require(`${app.getAppPath()}/node_modules/electron-updater`).autoUpdater;
        const scope = globalThis as unknown as {
          __downloads: number;
          __closeChoice: number;
          __quitForUpdate: boolean;
          __closePrompts: number;
        };
        scope.__closePrompts = 0;
        scope.__downloads = 0;
        scope.__closeChoice = 2;
        scope.__quitForUpdate = false;
        Object.defineProperty(app, "isPackaged", { value: true });
        updater.checkForUpdates = async () => ({
          isUpdateAvailable: true,
          updateInfo: { version: "1.0.0" },
        });
        updater.downloadUpdate = async () => {
          scope.__downloads++;
          updater.emit("update-downloaded");
          return [];
        };
        updater.quitAndInstall = () => {
          require("node:fs").writeFileSync(marker, "installed");
          scope.__quitForUpdate = true;
          app.quit();
        };
        dialog.showMessageBox = (async (...args: unknown[]) => {
          const options = args.at(-1) as { message: string };
          if (options.message.startsWith("Save changes")) scope.__closePrompts++;
          return {
            response: options.message.startsWith("Save changes") ? scope.__closeChoice : 0,
            checkboxChecked: false,
          };
        }) as typeof dialog.showMessageBox;
        dialog.showSaveDialog = (async () => ({
          canceled: false,
          filePath: output,
        })) as typeof dialog.showSaveDialog;
      },
      { marker, output },
    );
    const check = () =>
      app.evaluate(({ Menu }) => {
        const item = Menu.getApplicationMenu()
          ?.items.find((item) => item.label === "Application")
          ?.submenu?.items.find((item) => item.label === "Check for updates…");
        if (!item) throw new Error("Update command missing");
        item.enabled = true;
        item.click(item, undefined, {} as Electron.KeyboardEvent);
      });
    await check();
    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as unknown as { __downloads: number }).__downloads),
      )
      .toBe(1);
    await expect(page.getByTestId("history-dirty")).toHaveText("Unsaved changes");
    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as unknown as { __closePrompts: number }).__closePrompts),
      )
      .toBe(1);
    expect(
      await app.evaluate(
        () => (globalThis as unknown as { __quitForUpdate: boolean }).__quitForUpdate,
      ),
    ).toBe(false);
    await app.evaluate(() => {
      (globalThis as unknown as { __closeChoice: number }).__closeChoice = 0;
    });
    const closed = page.waitForEvent("close");
    await check();
    await closed;
    await expect.poll(async () => readFile(marker, "utf8").catch(() => "")).toBe("installed");
    expect((await readFile(output)).subarray(0, 4).toString()).toBe("RIFF");
  } finally {
    await closeEditor(app);
    await rm(directory, { recursive: true, force: true });
  }
});
