/// <reference lib="dom" />
import type { DocumentInfoResult, MetadataResult } from "@aae/protocol";
import { expect, type Page, test } from "@playwright/test";
import { runCommand } from "./command-fixture.ts";
import { fixture, info, LEFT, load, openDiscarding, RIGHT, samples } from "./edit-fixture.ts";
import { exportDownload, openExport, parseWAV, sourceState, wavChunk } from "./export-fixture.ts";
import { captureKernelWorker } from "./kernel-probe.ts";

async function metadata(page: Page) {
  return page.evaluate(async () => {
    const info = (await window.__aaeTest?.request("doc.info")) as DocumentInfoResult;
    return (await window.__aaeTest?.request("metadata.get", {
      documentId: info.documentId,
    })) as MetadataResult;
  });
}
/** History navigation mints a new document identity; wait for it before probing metadata. */
async function navigate(page: Page, action: () => Promise<unknown>) {
  const previous = (await info(page)).documentId;
  await action();
  await expect.poll(async () => (await info(page)).documentId).not.toBe(previous);
}
function chunk(id: string, data: Buffer) {
  const bytes = Buffer.alloc(8 + data.length + (data.length % 2));
  bytes.write(id);
  bytes.writeUInt32LE(data.length, 4);
  data.copy(bytes, 8);
  return bytes;
}
function taggedFixture() {
  const base = fixture();
  const info = Buffer.concat([
    Buffer.from("INFO"),
    chunk("INAM", Buffer.from("Imported title\0")),
    chunk("ZZZZ", Buffer.from([9, 8, 7])),
  ]);
  const bext = Buffer.alloc(602);
  bext.write("Original broadcast");
  const bytes = Buffer.concat([
    base,
    chunk("LIST", info),
    chunk("bext", bext),
    chunk("xtra", Buffer.from([1, 2, 3])),
  ]);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  return { bytes, bext };
}
test.beforeEach(async ({ page }) => {
  await captureKernelWorker(page);
  await page.addInitScript(() => Object.assign(window, { showSaveFilePicker: undefined }));
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
});
test("metadata edits, modal shortcuts, undo/redo and actual WAV export preserve PCM and unknown chunks", async ({
  page,
}) => {
  const input = taggedFixture();
  await page
    .getByTestId("audio-file-input")
    .setInputFiles({ name: "tagged.wav", mimeType: "audio/wav", buffer: input.bytes });
  await expect(page.getByTestId("document-name")).toHaveText("tagged.wav");
  const before = await sourceState(page);
  await runCommand(page, "file.metadata", "File");
  const dialog = page.getByRole("dialog", { name: "File metadata" });
  await expect(dialog.getByLabel("Title", { exact: true })).toHaveValue("Imported title");
  await expect(dialog).toContainText("bext");
  await dialog.getByLabel("Title", { exact: true }).fill("Edited 🎵");
  await dialog.getByLabel("Title", { exact: true }).press("ControlOrMeta+z");
  expect((await sourceState(page)).history).toEqual(before.history);
  await dialog.getByLabel("Title", { exact: true }).fill("Edited 🎵");
  await dialog.getByLabel("Artist", { exact: true }).fill("Artist");
  await dialog.getByRole("button", { name: "Apply metadata" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByTestId("history-dirty")).toHaveText("Unsaved changes");
  const after = await sourceState(page);
  expect(after.document).toEqual(before.document);
  expect(after.selection).toEqual(before.selection);
  expect(after.timeline).toEqual(before.timeline);
  expect(after.history.entries).toHaveLength(before.history.entries.length + 1);
  expect(await samples(page)).toEqual([LEFT, RIGHT]);
  expect((await metadata(page)).tags).toEqual({ title: "Edited 🎵", artist: "Artist" });
  await navigate(page, () => runCommand(page, "edit.undo", "Edit"));
  expect((await metadata(page)).tags.title).toBe("Imported title");
  await expect(page.getByTestId("history-dirty")).toHaveText("Saved");
  await navigate(page, () => runCommand(page, "edit.redo", "Edit"));
  expect((await metadata(page)).tags.title).toBe("Edited 🎵");
  await openExport(page);
  const exported = await exportDownload(page);
  expect(parseWAV(exported.bytes).data).toEqual(parseWAV(input.bytes).data);
  expect(wavChunk(exported.bytes, "bext")).toEqual(input.bext);
  expect(wavChunk(exported.bytes, "xtra")).toEqual(Buffer.from([1, 2, 3]));
  expect(exported.bytes.includes(chunk("ZZZZ", Buffer.from([9, 8, 7])))).toBe(true);
  const oldID = (await info(page)).documentId;
  await openDiscarding(page, {
    name: "reopened.wav",
    mimeType: "audio/wav",
    buffer: exported.bytes,
  });
  await expect.poll(async () => (await info(page)).documentId).not.toBe(oldID);
  expect((await metadata(page)).tags).toEqual({ title: "Edited 🎵", artist: "Artist" });
  expect(await samples(page)).toEqual([LEFT, RIGHT]);
});
test("cancelled and unchanged metadata drafts keep the save point and history", async ({
  page,
}) => {
  await load(page);
  const before = await sourceState(page);
  await runCommand(page, "file.metadata", "File");
  const dialog = page.getByRole("dialog", { name: "File metadata" });
  await expect(dialog.getByLabel("Title", { exact: true })).toBeEnabled();
  await dialog.getByLabel("Title", { exact: true }).fill("Cancelled");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  expect(await sourceState(page)).toEqual(before);
  await runCommand(page, "file.metadata", "File");
  await expect(dialog.getByLabel("Title", { exact: true })).toHaveValue("");
  await dialog.getByRole("button", { name: "Apply metadata" }).click();
  await expect(dialog).not.toBeVisible();
  expect(await sourceState(page)).toEqual(before);
});
