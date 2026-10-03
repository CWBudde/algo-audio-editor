/// <reference lib="dom" />

import { type Download, expect, type Page } from "@playwright/test";
import type { HistoryListResult, TimelineResult } from "../../../packages/protocol/src/index.js";
import { info } from "./edit-fixture.js";

export async function sourceState(page: Page) {
  const document = await info(page);
  return page.evaluate(
    async (document) => ({
      document,
      history: (await window.__aaeTest?.request("history.list", {
        documentId: document.documentId,
      })) as HistoryListResult,
      timeline: (await window.__aaeTest?.request("timeline.get", {
        documentId: document.documentId,
      })) as TimelineResult,
      selection: await window.__aaeTest?.request("selection.get", {
        documentId: document.documentId,
      }),
    }),
    document,
  );
}
export async function openExport(page: Page) {
  await page.getByRole("menuitem", { name: "File", exact: true }).click();
  await page.locator('[role="menuitem"][data-command-id="file.export"]').click();
  const dialog = page.getByRole("dialog", { name: "Export audio" });
  await expect(dialog).toBeVisible();
  return dialog;
}
export async function downloadedBytes(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  if (!stream) throw new Error("download stream missing");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
export function wavChunk(bytes: Buffer, id: string) {
  expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
  expect(bytes.toString("ascii", 8, 12)).toBe("WAVE");
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const size = bytes.readUInt32LE(offset + 4);
    if (bytes.toString("ascii", offset, offset + 4) === id)
      return bytes.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  throw new Error(`WAV ${id} chunk missing`);
}
export function parseWAV(bytes: Buffer) {
  const fmt = wavChunk(bytes, "fmt ");
  const data = wavChunk(bytes, "data");
  const tag = fmt.readUInt16LE(0);
  const channels = fmt.readUInt16LE(2);
  const sampleRate = fmt.readUInt32LE(4);
  const bitDepth = fmt.readUInt16LE(14);
  const width = bitDepth / 8;
  const frames = data.length / (channels * width);
  const samples = Array.from({ length: channels }, (_, channel) =>
    Array.from({ length: frames }, (_, frame) => {
      const offset = (frame * channels + channel) * width;
      if (tag === 3) return bitDepth === 64 ? data.readDoubleLE(offset) : data.readFloatLE(offset);
      return bitDepth === 8
        ? (data.readUInt8(offset) - 128) / 128
        : data.readIntLE(offset, width) / 2 ** (bitDepth - 1);
    }),
  );
  return { tag, channels, sampleRate, bitDepth, frames, samples, data };
}
export async function exportDownload(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Export audio" });
  const downloading = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  const download = await downloading;
  await expect(dialog).not.toBeVisible();
  return { download, bytes: await downloadedBytes(download) };
}
