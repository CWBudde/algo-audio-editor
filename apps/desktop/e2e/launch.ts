import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ElectronApplication, _electron as electron, expect } from "@playwright/test";

/** Give each real application an isolated profile and deterministic dialogs. */
export async function launchEditor(options: Parameters<typeof electron.launch>[0]) {
  const directory = await mkdtemp(path.join(tmpdir(), "aae-desktop-"));
  const app = await electron.launch({
    ...options,
    // Without a GPU (CI under xvfb), the first accelerated 2D canvas makes the
    // renderer wait synchronously on a cold software-GL GPU process, which
    // blocked the first waveform for 5-10 s on fresh runners. Rasterize canvases
    // in software instead; the editor draws only 2D canvases.
    args: [...(options?.args ?? []), "--disable-gpu"],
    env: { ...process.env, ...options?.env, AAE_USER_DATA: directory },
  });
  app.on("close", () => {
    void rm(directory, { recursive: true, force: true });
  });
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as { buttons?: string[] };
      return { response: options.buttons?.indexOf("Discard") ?? 0, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  });
  const page = await app.firstWindow();
  await page.waitForURL("app://editor/index.html", { waitUntil: "load" });
  return app;
}

export async function closeEditor(app: ElectronApplication) {
  // Exit without tearing windows down. Destroying several windows in one tick
  // crashes Electron on macOS: the deferred NSWindow close makes the next,
  // already destroyed window key and its observer touches freed memory. Exiting
  // also skips the unsaved-work guard, which tests must not wait on.
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
}

/** Click a native application-menu item by command id once it is enabled. */
export async function menuCommand(app: ElectronApplication, id: string) {
  await expect
    .poll(() =>
      app.evaluate(({ Menu, BrowserWindow }, id) => {
        const item = Menu.getApplicationMenu()?.getMenuItemById(id);
        if (!item?.enabled) return false;
        item.click(item, BrowserWindow.getAllWindows()[0], {} as Electron.KeyboardEvent);
        return true;
      }, id),
    )
    .toBe(true);
}
