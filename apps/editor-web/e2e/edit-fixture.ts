/// <reference lib="dom" />
import type {
  ClipboardInfo,
  DocumentInfoResult,
  ExportResult,
  SelectionResult,
} from "@aae/protocol";
import { expect, type Page } from "@playwright/test";

export const LEFT = [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];
export const RIGHT = [-1, -0.875, -0.75, -0.625, -0.5, -0.375, -0.25, -0.125];

export function fixture(channels = [LEFT, RIGHT], rate = 48_000) {
  const frames = channels[0].length;
  const bytes = Buffer.alloc(44 + frames * channels.length * 4);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(3, 20);
  bytes.writeUInt16LE(channels.length, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * channels.length * 4, 28);
  bytes.writeUInt16LE(channels.length * 4, 32);
  bytes.writeUInt16LE(32, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels.length; channel++) {
      bytes.writeFloatLE(channels[channel][frame], 44 + (frame * channels.length + channel) * 4);
    }
  }
  return bytes;
}

export async function load(page: Page, channels = [LEFT, RIGHT], rate = 48_000) {
  const previous = await page.evaluate(async () => {
    try {
      const document = (await window.__aaeTest?.request("doc.info")) as
        | DocumentInfoResult
        | undefined;
      return document?.documentId;
    } catch {
      return undefined;
    }
  });
  await page.getByTestId("audio-file-input").setInputFiles({
    name: `edit-${rate}.wav`,
    mimeType: "audio/wav",
    buffer: fixture(channels, rate),
  });
  await expect.poll(async () => (await info(page)).documentId).not.toBe(previous);
  await expect(page.getByTestId("document-details")).toContainText(
    `${rate} Hz · ${channels.length} channel${channels.length === 1 ? "" : "s"} · ${channels[0].length} frames`,
  );
  await expect(page.getByLabel("Selection end", { exact: true })).toBeEnabled();
  await page.getByLabel("Time format", { exact: true }).selectOption("samples");
}

export async function info(page: Page) {
  return page.evaluate(
    async () => (await window.__aaeTest?.request("doc.info")) as DocumentInfoResult,
  );
}

export async function clipboard(page: Page) {
  return page.evaluate(
    async () => (await window.__aaeTest?.request("edit.state")) as ClipboardInfo,
  );
}

export async function select(page: Page, start: number, end: number) {
  for (const [field, value] of [
    ["start", 0],
    ["end", end],
    ["start", start],
  ] as const) {
    const input = page.getByLabel(`Selection ${field}`, { exact: true });
    await input.fill(String(value));
    await input.press("Enter");
  }
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const document = (await window.__aaeTest?.request("doc.info")) as DocumentInfoResult;
        const range = (await window.__aaeTest?.request("selection.get", {
          documentId: document.documentId,
        })) as SelectionResult;
        return { start: range.start, end: range.end };
      }),
    )
    .toEqual({ start, end });
}

export async function samples(page: Page) {
  return page.evaluate(async () => {
    const result = (await window.__aaeTest?.request("doc.export", {
      format: "wav",
      bitDepth: 32,
      float: true,
    })) as ExportResult;
    const view = new DataView(result.data);
    const tag = (offset: number) => String.fromCharCode(...new Uint8Array(result.data, offset, 4));
    let channels = 0;
    for (let offset = 12; offset + 8 <= view.byteLength; ) {
      const size = view.getUint32(offset + 4, true);
      if (tag(offset) === "fmt ") channels = view.getUint16(offset + 10, true);
      if (tag(offset) === "data")
        return Array.from({ length: channels }, (_, channel) =>
          Array.from({ length: size / (channels * 4) }, (_, frame) =>
            view.getFloat32(offset + 8 + (frame * channels + channel) * 4, true),
          ),
        );
      offset += 8 + size + (size % 2);
    }
    throw new Error("exported WAV has no data chunk");
  });
}

export async function edit(page: Page, name: string, frames: number) {
  const previous = (await info(page)).documentId;
  await page.getByRole("button", { name, exact: true }).click();
  await expect.poll(async () => (await info(page)).documentId).not.toBe(previous);
  await expect(page.getByTestId("document-details")).toContainText(`· ${frames} frames`);
  await expect(page.getByLabel("Selection start", { exact: true })).toBeEnabled();
}
