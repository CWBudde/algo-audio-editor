import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ElectronApplication, expect, test } from "@playwright/test";
import {
  editAndWait,
  editorReady,
  recoverOffered,
  snapshot,
} from "../../editor-web/e2e/autosave-fixture.js";
import { captureKernelWorker } from "../../editor-web/e2e/kernel-probe.js";
import { closeEditor, launchEditor } from "./launch.js";

async function probedWindow(app: ElectronApplication) {
  const page = await app.firstWindow();
  await captureKernelWorker(page);
  await page.reload();
  await editorReady(page);
  return page;
}

/** SIGKILL: no window close, no unload handlers, no storage flush. */
async function kill(app: ElectronApplication) {
  const exited = new Promise((resolve) => app.process().once("exit", resolve));
  app.process().kill("SIGKILL");
  await exited;
}

test("a killed Electron process keeps edits older than 5 s and recovers them", async () => {
  test.setTimeout(120_000);
  const userData = await mkdtemp(path.join(tmpdir(), "aae-desktop-autosave-"));
  const args = [path.join(__dirname, "..")];
  try {
    const first = await launchEditor({ args }, { userData });
    let before: Awaited<ReturnType<typeof snapshot>>;
    try {
      before = await editAndWait(await probedWindow(first));
    } finally {
      await kill(first);
    }

    const second = await launchEditor({ args }, { userData });
    try {
      const page = await probedWindow(second);
      await recoverOffered(page);
      expect(await snapshot(page)).toEqual(before);
      await expect(page.getByTestId("history-dirty")).toHaveText("Unsaved changes");
      expect(
        await second.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].isDocumentEdited(),
        ),
      ).toBe(true);
    } finally {
      await closeEditor(second);
    }
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});
