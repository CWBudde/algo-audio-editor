import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { closeEditor, launchEditor } from "./launch.js";

const desktopRoot = path.dirname(require.resolve("../package.json"));
const fixture = (format: string) =>
  path.resolve(desktopRoot, `../../packages/kernel/internal/engine/testdata/codecs/tone.${format}`);
for (const format of ["flac", "aiff", "mp3"]) {
  test(`native launch and save for ${format}`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "aae-codec-"));
    const input = path.join(directory, `input.${format}`),
      output = path.join(directory, `saved.${format === "mp3" ? "wav" : format}`);
    await writeFile(input, await readFile(fixture(format)));
    const app = await launchEditor({ args: [desktopRoot, input] });
    try {
      const page = await app.firstWindow();
      await expect(page.getByTestId("document-name")).toHaveText(`input.${format}`);
      await app.evaluate(({ dialog }, output) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: output });
      }, output);
      await expect
        .poll(() =>
          app.evaluate(
            ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("file.save")?.enabled,
          ),
        )
        .toBe(true);
      await app.evaluate(({ Menu, BrowserWindow }) => {
        const item = Menu.getApplicationMenu()?.getMenuItemById("file.save");
        item?.click(item, BrowserWindow.getAllWindows()[0], {} as Electron.KeyboardEvent);
      });
      await expect
        .poll(async () => {
          try {
            return (await readFile(output)).subarray(0, 4).toString();
          } catch {
            return "";
          }
        })
        .toBe(format === "flac" ? "fLaC" : format === "aiff" ? "FORM" : "RIFF");
      await expect(page.getByTestId("history-dirty")).toHaveText("Saved");
    } finally {
      await closeEditor(app);
      await rm(directory, { recursive: true, force: true });
    }
  });
}
