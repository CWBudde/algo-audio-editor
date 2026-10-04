import { app, BrowserWindow, dialog } from "electron";
import { autoUpdater } from "electron-updater";

/** Use builder's packaged app-update.yml; never accept renderer-supplied feeds. */
export function registerUpdates() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  let checking = false;
  let downloaded = false;
  let installOnQuit = false;
  const message = async (options: Electron.MessageBoxOptions) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
  };
  autoUpdater.on("error", (error) => {
    console.error("Update error", error);
  });
  autoUpdater.on("update-downloaded", () => {
    downloaded = true;
  });
  // app.quit respects every window's unsaved-work guard. Install only after
  // all windows actually close; cancellation keeps the update staged.
  app.on("will-quit", (event) => {
    if (event.defaultPrevented || !downloaded || !installOnQuit) return;
    event.preventDefault();
    installOnQuit = false;
    autoUpdater.quitAndInstall(false, true);
  });
  return async () => {
    if (!app.isPackaged || checking) return;
    checking = true;
    try {
      if (!downloaded) {
        const result = await autoUpdater.checkForUpdates();
        if (!result?.isUpdateAvailable) {
          await message({ type: "info", message: "You are using the latest version." });
          return;
        }
        const choice = await message({
          type: "question",
          message: `Download version ${result.updateInfo.version}?`,
          buttons: ["Download", "Cancel"],
          defaultId: 0,
          cancelId: 1,
        });
        if (choice.response !== 0) return;
        await autoUpdater.downloadUpdate();
      }
      const choice = await message({
        type: "question",
        message: "The update is ready.",
        detail: "Restart to install it. You will be prompted to save any unsaved documents.",
        buttons: ["Restart", "Later"],
        defaultId: 0,
        cancelId: 1,
      });
      if (choice.response === 0) {
        installOnQuit = true;
        app.quit();
      }
    } catch (error) {
      await message({
        type: "error",
        message: "Could not update the application.",
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      checking = false;
    }
  };
}
