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

test("native metadata command, modal fencing and saved WAV tags survive reopening", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aae-metadata-"));
  const output = path.join(directory, "metadata.wav");
  const app = await launchEditor({ args: [desktopRoot] });
  try {
    const page = await app.firstWindow();
    await captureKernelWorker(page);
    await page.reload();
    await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
    await load(page, [[0, 0.5, -0.5, 0]]);
    const before = await sourceState(page);
    await expect
      .poll(() =>
        app.evaluate(
          ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("file.metadata")?.enabled,
        ),
      )
      .toBe(true);
    await app.evaluate(({ Menu, BrowserWindow }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById("file.metadata");
      item?.click(item, BrowserWindow.getAllWindows()[0], {} as Electron.KeyboardEvent);
    });
    const dialog = page.getByRole("dialog", { name: "File metadata" });
    await expect(dialog.getByLabel("Title", { exact: true })).toBeEnabled();
    await expect
      .poll(() =>
        app.evaluate(
          ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("file.save")?.enabled,
        ),
      )
      .toBe(false);
    await dialog.getByLabel("Title", { exact: true }).fill("Native title 🎵");
    await dialog.getByRole("button", { name: "Apply metadata" }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByTestId("history-dirty")).toHaveText("Unsaved changes");
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
    await expect(page.getByTestId("history-dirty")).toHaveText("Saved");
    const bytes = await readFile(output);
    expect(bytes.includes(Buffer.from("Native title 🎵\0"))).toBe(true);
    expect((await sourceState(page)).document).toEqual(before.document);
    const previous = (await sourceState(page)).document.documentId;
    await app.evaluate(({ dialog }, output) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [output] });
    }, output);
    await expect
      .poll(() =>
        app.evaluate(
          ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("file.open")?.enabled,
        ),
      )
      .toBe(true);
    await app.evaluate(({ Menu, BrowserWindow }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById("file.open");
      item?.click(item, BrowserWindow.getAllWindows()[0], {} as Electron.KeyboardEvent);
    });
    await expect.poll(async () => (await sourceState(page)).document.documentId).not.toBe(previous);
    await app.evaluate(({ Menu, BrowserWindow }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById("file.metadata");
      item?.click(item, BrowserWindow.getAllWindows()[0], {} as Electron.KeyboardEvent);
    });
    await expect(dialog.getByLabel("Title", { exact: true })).toHaveValue("Native title 🎵");
    await dialog.getByRole("button", { name: "Cancel" }).click();
  } finally {
    await closeEditor(app);
    await rm(directory, { recursive: true, force: true });
  }
});
