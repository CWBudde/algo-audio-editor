import { mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { fixture, LEFT, load, RIGHT } from "../../editor-web/e2e/edit-fixture.js";
import { parseWAV, sourceState } from "../../editor-web/e2e/export-fixture.js";
import { captureKernelWorker } from "../../editor-web/e2e/kernel-probe.js";
import { closeEditor, launchEditor } from "./launch.js";

test("batch folder grants confine atomic writes, refuse overwrite and expire on release", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aae-batch-folder-"));
  const app = await launchEditor({ args: [path.join(__dirname, "..")] });
  try {
    const page = await app.firstWindow();
    await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [directory],
      })) as typeof dialog.showOpenDialog;
    }, directory);
    const folder = await page.evaluate(() => window.aaeDesktop?.pickBatchDirectory?.());
    expect(folder?.name).toBe(path.basename(directory));
    const rejected = (id: string, name: string) =>
      page.evaluate(
        async ({ id, name }) => {
          try {
            await window.aaeDesktop?.writeBatchFile?.(id, name, new Uint8Array([1, 2, 3]).buffer);
            return false;
          } catch {
            return true;
          }
        },
        { id, name },
      );
    const id = folder?.id ?? "";
    expect(await rejected("not-a-grant", "result.wav")).toBe(true);
    for (const name of [
      "../escape.wav",
      "sub/result.wav",
      "sub\\result.wav",
      "output.json",
      "result.wav.",
      "result.wav ",
    ])
      expect(await rejected(id, name)).toBe(true);
    await page.evaluate(async (id) => {
      await window.aaeDesktop?.writeBatchFile?.(id, "result.wav", new Uint8Array([1, 2, 3]).buffer);
    }, id);
    expect(await readFile(path.join(directory, "result.wav"))).toEqual(Buffer.from([1, 2, 3]));
    expect(await rejected(id, "result.wav")).toBe(true);
    const outside = `${directory}-outside.wav`;
    await writeFile(outside, "original");
    try {
      await symlink(outside, path.join(directory, "linked.wav"));
      expect(await rejected(id, "linked.wav")).toBe(true);
      expect(await readFile(outside, "utf8")).toBe("original");
    } finally {
      await rm(outside, { force: true });
    }
    expect((await readdir(directory)).sort()).toEqual(["linked.wav", "result.wav"]);
    await page.evaluate((id) => window.aaeDesktop?.releaseBatchDirectory?.(id), id);
    expect(await rejected(id, "released.wav")).toBe(true);
    const next = await page.evaluate(() => window.aaeDesktop?.pickBatchDirectory?.());
    const moved = `${directory}-moved`;
    await rename(directory, moved);
    try {
      await symlink(moved, directory);
      expect(await rejected(next?.id ?? "", "changed.wav")).toBe(true);
      expect((await readdir(moved)).sort()).toEqual(["linked.wav", "result.wav"]);
    } finally {
      await rm(directory, { force: true });
      await rename(moved, directory);
    }
  } finally {
    await closeEditor(app);
    await rm(directory, { recursive: true, force: true });
  }
});

test("native batch menu processes files into one chosen folder without changing the editor", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aae-native-batch-"));
  const app = await launchEditor({ args: [path.join(__dirname, "..")] });
  try {
    const page = await app.firstWindow();
    await captureKernelWorker(page);
    await page.reload();
    await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
    await load(page);
    const before = await sourceState(page);
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [directory],
      })) as typeof dialog.showOpenDialog;
    }, directory);
    await expect
      .poll(() =>
        app.evaluate(({ Menu, BrowserWindow }) => {
          const item = Menu.getApplicationMenu()?.getMenuItemById("file.batch");
          if (!item?.enabled) return false;
          item.click(item, BrowserWindow.getAllWindows()[0], {} as Electron.KeyboardEvent);
          return true;
        }),
      )
      .toBe(true);
    const dialog = page.getByRole("dialog", { name: "Batch processing", exact: true });
    await dialog.getByLabel("Batch audio files", { exact: true }).setInputFiles([
      { name: "first.wav", mimeType: "audio/wav", buffer: fixture() },
      { name: "second.wav", mimeType: "audio/wav", buffer: fixture() },
    ]);
    await dialog.getByLabel("Import batch chain", { exact: true }).setInputFiles({
      name: "reverse.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          version: 1,
          operations: [
            { method: "process.start", range: "document", params: { operation: "reverse" } },
          ],
        }),
      ),
    });
    await dialog.getByLabel("Batch output format", { exact: true }).selectOption("wav");
    await dialog.getByLabel("Batch encoding", { exact: true }).selectOption("float");
    await dialog.getByLabel("Batch bit depth", { exact: true }).selectOption("32");
    await dialog.getByRole("button", { name: "Choose output folder", exact: true }).click();
    await dialog.getByRole("button", { name: "Start batch", exact: true }).click();
    await expect(dialog.getByRole("status", { name: "Batch progress" })).toContainText(
      "2 of 2 files completed · 2 succeeded · 0 failed · 0 cancelled",
    );
    for (const name of ["first-processed.wav", "second-processed.wav"]) {
      expect(parseWAV(await readFile(path.join(directory, name)))).toMatchObject({
        tag: 3,
        sampleRate: 48000,
        bitDepth: 32,
        samples: [[...LEFT].reverse(), [...RIGHT].reverse()],
      });
    }
    expect((await readdir(directory)).sort()).toEqual([
      "first-processed.wav",
      "second-processed.wav",
    ]);
    expect(await sourceState(page)).toEqual(before);
  } finally {
    await closeEditor(app);
    await rm(directory, { recursive: true, force: true });
  }
});
