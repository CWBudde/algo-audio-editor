import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { load } from "../../editor-web/e2e/edit-fixture.js";
import { openExport, sourceState } from "../../editor-web/e2e/export-fixture.js";
import { captureKernelWorker } from "../../editor-web/e2e/kernel-probe.js";
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

test("native Opus export writes a playable copy and keeps the source save point", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aae-opus-")),
    output = path.join(directory, "copy.opus");
  const app = await launchEditor({ args: [desktopRoot] });
  try {
    const page = await app.firstWindow();
    await captureKernelWorker(page);
    await page.reload();
    await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
    const signal = Array.from(
      { length: 4097 },
      (_, i) => 0.25 * Math.sin((2 * Math.PI * 440 * i) / 48000),
    );
    await load(page, [signal]);
    const before = await sourceState(page);
    await app.evaluate(({ dialog }, output) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: output });
    }, output);
    const dialog = await openExport(page);
    await expect(dialog.locator('option[value="opus"]')).toBeEnabled();
    await dialog.getByLabel("Format", { exact: true }).selectOption("opus");
    await dialog.getByRole("button", { name: "Export", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const bytes = await readFile(output);
    expect(bytes.subarray(0, 4).toString()).toBe("OggS");
    const decoded = await page.evaluate(async (bytes) => {
      const audio = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(
        new Uint8Array(bytes).buffer,
      );
      return { frames: audio.length, channels: audio.numberOfChannels, rate: audio.sampleRate };
    }, Array.from(bytes));
    expect(decoded).toEqual({ frames: 4097, channels: 1, rate: 48000 });
    expect(await sourceState(page)).toEqual(before);
  } finally {
    await closeEditor(app);
    await rm(directory, { recursive: true, force: true });
  }
});
