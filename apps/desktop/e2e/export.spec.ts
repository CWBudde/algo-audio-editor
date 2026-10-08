import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { LEFT, load, RIGHT, samples, select } from "../../editor-web/e2e/edit-fixture.js";
import { openExport, parseWAV, sourceState } from "../../editor-web/e2e/export-fixture.js";
import { captureKernelWorker } from "../../editor-web/e2e/kernel-probe.js";
import { revealControl } from "../../editor-web/e2e/ui-disclosures.js";
import { closeEditor, launchEditor } from "./launch.js";

async function observeExports(app: ElectronApplication, directory: string) {
  await app.evaluate(({ dialog }, directory) => {
    const scope = globalThis as unknown as { __aaeExports: string[] };
    scope.__aaeExports = [];
    dialog.showSaveDialog = (async (...args: unknown[]) => {
      const options = args.at(-1) as { defaultPath: string };
      const destination = `${directory}/${options.defaultPath}`;
      scope.__aaeExports.push(destination);
      return { canceled: false, filePath: destination };
    }) as typeof dialog.showSaveDialog;
  }, directory);
}
async function exportToDisk(app: ElectronApplication, page: Page) {
  const index = await app.evaluate(
    () => (globalThis as unknown as { __aaeExports: string[] }).__aaeExports.length,
  );
  const dialog = page.getByRole("dialog", { name: "Export audio" });
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const destination = await app.evaluate(
    (_electron, index) => (globalThis as unknown as { __aaeExports: string[] }).__aaeExports[index],
    index,
  );
  return { name: path.basename(destination), bytes: await readFile(destination) };
}

test("desktop Export dialog writes selected channel WAV and quality encodings without saving its source", async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(path.join(tmpdir(), "aae-export-"));
  const app = await launchEditor({
    args: [path.join(__dirname, ".."), "--autoplay-policy=no-user-gesture-required"],
  });
  try {
    const page = await app.firstWindow();
    await captureKernelWorker(page);
    await observeExports(app, directory);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.reload();
    await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
    await load(page);
    await select(page, 2, 6);
    await (
      await revealControl(
        page.getByRole("button", { name: "Right", exact: true, includeHidden: true }),
      )
    ).click();
    const before = await sourceState(page);
    const opener = page.getByLabel("Selection start", { exact: true });
    await opener.focus();
    await page.keyboard.press("ControlOrMeta+Shift+E");
    let dialog = page.getByRole("dialog", { name: "Export audio" });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(opener).toBeFocused();
    dialog = await openExport(page);
    await dialog.getByLabel("Range", { exact: true }).selectOption("selection");
    await dialog.getByLabel("Format", { exact: true }).selectOption("pcm");
    await dialog.getByLabel("Bit depth", { exact: true }).selectOption("24");
    const selected = await exportToDisk(app, page);
    expect(selected.name).toBe("edit-48000-selection.wav");
    expect(parseWAV(selected.bytes)).toMatchObject({
      tag: 1,
      channels: 1,
      sampleRate: 48000,
      frames: 4,
      bitDepth: 24,
      samples: [RIGHT.slice(2, 6)],
    });
    dialog = await openExport(page);
    await dialog.getByLabel("Bit depth", { exact: true }).selectOption("64");
    const floating = parseWAV((await exportToDisk(app, page)).bytes);
    expect(floating).toMatchObject({ tag: 3, bitDepth: 64, samples: [LEFT, RIGHT] });
    expect(await sourceState(page)).toEqual(before);
    expect(await samples(page)).toEqual([LEFT, RIGHT]);
    const quiet = Array.from({ length: 512 }, (_, index) => (index % 2 ? -1 : 1) / 131072);
    await load(page, [quiet]);
    const quietBefore = await sourceState(page);
    dialog = await openExport(page);
    await dialog.getByLabel("Format", { exact: true }).selectOption("pcm");
    await dialog.getByLabel("Bit depth", { exact: true }).selectOption("16");
    const baseline = parseWAV((await exportToDisk(app, page)).bytes);
    dialog = await openExport(page);
    await dialog.getByLabel("Format", { exact: true }).selectOption("pcm");
    await dialog.getByLabel("Bit depth", { exact: true }).selectOption("16");
    await dialog.getByLabel("Dither", { exact: true }).selectOption("triangular");
    await dialog.getByLabel("Noise shaping", { exact: true }).selectOption("9fc");
    const shaped = parseWAV((await exportToDisk(app, page)).bytes);
    expect(shaped.data.equals(baseline.data)).toBe(false);
    expect(
      shaped.samples[0].every((value) => Number.isFinite(value) && Math.abs(value) < 0.01),
    ).toBe(true);
    expect(await sourceState(page)).toEqual(quietBefore);
    expect(errors).toEqual([]);
  } finally {
    await closeEditor(app);
    await rm(directory, { recursive: true, force: true });
  }
});
