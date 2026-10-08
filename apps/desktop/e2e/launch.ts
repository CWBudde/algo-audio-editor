import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ElectronApplication, _electron as electron } from "@playwright/test";

/** Give each real application an isolated profile and deterministic dialogs. */
export async function launchEditor(options: Parameters<typeof electron.launch>[0]) {
  const directory = await mkdtemp(path.join(tmpdir(), "aae-desktop-"));
  const app = await electron.launch({
    ...options,
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
