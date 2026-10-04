/// <reference lib="dom" />
import { type Download, expect, test } from "@playwright/test";
import type { PeaksGetResult } from "../../../packages/protocol/src/index.ts";
import { captureKernelWorker } from "./kernel-probe.ts";
import { playbackWAV } from "./playback-fixture.js";

function wavFixture(bitDepth: number, float = false): Buffer {
  const integers = [-32768, 32767, -16384, 16384, 0, 0, 8192, -8192];
  const pcm24 = [-8388608, 8388607, -4194303, 4194305, 1, -1, 2097153, -2097155];
  const floating = [-1.25, 1.5, -0.5, 0.5, 0, 0, 0.25, -0.25];
  const bytesPerSample = bitDepth / 8;
  const buffer = Buffer.alloc(44 + integers.length * bytesPerSample);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(float ? 3 : 1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(44100, 24);
  buffer.writeUInt32LE(44100 * 2 * bytesPerSample, 28);
  buffer.writeUInt16LE(2 * bytesPerSample, 32);
  buffer.writeUInt16LE(bitDepth, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(integers.length * bytesPerSample, 40);
  for (let i = 0; i < integers.length; i++) {
    if (float) buffer.writeFloatLE(floating[i], 44 + i * bytesPerSample);
    else
      buffer.writeIntLE(
        bitDepth === 24 ? pcm24[i] : integers[i],
        44 + i * bytesPerSample,
        bytesPerSample,
      );
  }
  return buffer;
}

function wavChunk(bytes: Buffer, id: string): Buffer {
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

async function downloadBytes(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  if (!stream) throw new Error("download stream missing");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

for (const format of [
  { bitDepth: 16, float: false },
  { bitDepth: 24, float: false },
  { bitDepth: 32, float: true },
]) {
  test(`opens and saves stereo ${format.bitDepth}-bit ${format.float ? "float" : "PCM"} without changing samples`, async ({
    page,
  }) => {
    await captureKernelWorker(page);
    await page.addInitScript(() => {
      Object.assign(window, { showOpenFilePicker: undefined, showSaveFilePicker: undefined });
    });
    await page.goto("/");
    await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
    if (format.bitDepth === 16) {
      await page.getByTestId("audio-file-input").setInputFiles({
        name: "previous-playback.wav",
        mimeType: "audio/wav",
        buffer: playbackWAV(480000),
      });
      await expect(page.getByTestId("document-name")).toHaveText("previous-playback.wav");
      await page.getByTestId("play").click();
      await expect
        .poll(async () => Number(await page.getByTestId("frames-played").textContent()))
        .toBeGreaterThan(0);
    }
    const source = wavFixture(format.bitDepth, format.float);
    const name = `stereo-${format.bitDepth}.wav`;
    const selected = { name, mimeType: "audio/wav", buffer: source };
    if (format.bitDepth === 24) {
      const chooserPromise = page.waitForEvent("filechooser");
      await page.getByRole("menuitem", { name: "File", exact: true }).click();
      await page.getByRole("menuitem", { name: /^Open…/ }).click();
      const chooser = await chooserPromise;
      await chooser.setFiles(selected);
    } else {
      await page.getByTestId("audio-file-input").setInputFiles(selected);
    }
    await expect(page.getByTestId("document-name")).toHaveText(name);
    await expect(page.getByTestId("document-details")).toContainText(
      `44100 Hz · 2 channels · 4 frames`,
    );
    await expect(page.getByText("No document open", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("play")).toBeEnabled();
    await expect(page.getByTestId("stop")).toBeDisabled();
    await expect
      .poll(async () =>
        Number((await page.getByTestId("document-memory").textContent())?.split(" ")[0]),
      )
      .toBeGreaterThan(0);
    const transfers = await page.evaluate(() => window.__aaeTest?.transfers);
    expect(transfers?.slice(-1)).toEqual([{ before: source.length, after: 0 }]);

    const peaks = await page.evaluate(async () => {
      const result = (await window.__aaeTest?.request("peaks.get", {
        channel: 0,
        startFrame: 0,
        endFrame: 4,
        buckets: 4,
      })) as PeaksGetResult;
      return {
        isBuffer: result.data instanceof ArrayBuffer,
        count: result.count,
        triples: Array.from(new Float32Array(result.data, 0, result.count * 3)),
        frameCounts: Array.from(new Uint32Array(result.data, result.count * 12, result.count)),
        startFrames: Array.from(new Float64Array(result.data, result.count * 16, result.count)),
      };
    });
    expect(peaks.isBuffer).toBe(true);
    expect(peaks.count).toBe(4);
    expect(peaks.frameCounts).toEqual([1, 1, 1, 1]);
    expect(peaks.startFrames).toEqual([0, 1, 2, 3]);
    const values = format.float
      ? [-1.25, -0.5, 0, 0.25]
      : format.bitDepth === 24
        ? [-1, -4194303 / 8388608, 1 / 8388608, 2097153 / 8388608]
        : [-1, -0.5, 0, 0.25];
    for (let i = 0; i < values.length; i++) {
      expect(peaks.triples.slice(i * 3, i * 3 + 3)).toEqual([
        values[i],
        values[i],
        Math.abs(values[i]),
      ]);
    }

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "File", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Save\b/ }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(name);
    const saved = await downloadBytes(download);
    const savedFormat = wavChunk(saved, "fmt ");
    expect(savedFormat.readUInt16LE(0)).toBe(format.float ? 3 : 1);
    expect(savedFormat.readUInt16LE(2)).toBe(2);
    expect(savedFormat.readUInt32LE(4)).toBe(44100);
    expect(savedFormat.readUInt16LE(14)).toBe(format.bitDepth);
    expect(wavChunk(saved, "data")).toEqual(wavChunk(source, "data"));
  });
}

test("imports a dropped WAV and preserves it when a later open fails", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
  await page.evaluate(
    (bytes) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], "dropped.wav", { type: "audio/wav" }));
      document
        .querySelector('[data-testid="document-drop-zone"]')
        ?.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
    },
    Array.from(wavFixture(16)),
  );
  await expect(page.getByTestId("document-name")).toHaveText("dropped.wav");
  await page
    .getByTestId("audio-file-input")
    .setInputFiles({ name: "broken.wav", mimeType: "audio/wav", buffer: Buffer.from("invalid") });
  await expect(page.getByText("Could not open audio", { exact: true })).toBeVisible();
  await expect(page.getByTestId("document-name")).toHaveText("dropped.wav");
});

test("treats a zero-frame WAV as an open document that can be saved", async ({ page }) => {
  await page.addInitScript(() => Object.assign(window, { showSaveFilePicker: undefined }));
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
  const source = wavFixture(16).subarray(0, 44);
  source.writeUInt32LE(36, 4);
  source.writeUInt32LE(0, 40);
  await page
    .getByTestId("audio-file-input")
    .setInputFiles({ name: "empty.wav", mimeType: "audio/wav", buffer: source });
  await expect(page.getByTestId("document-name")).toHaveText("empty.wav");
  await expect(page.getByTestId("document-details")).toContainText("0 frames · 0.000 s");
  await expect(page.getByText("No document open", { exact: true })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "File", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: /^Save\b/ })).toBeEnabled();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: /^Export audio…/ }).click();
  await page
    .getByRole("dialog", { name: "Export audio" })
    .getByRole("button", { name: "Export", exact: true })
    .click();
  const downloaded = await downloadPromise;
  expect(downloaded.suggestedFilename()).toBe("empty.wav");
  expect(wavChunk(await downloadBytes(downloaded), "data")).toHaveLength(0);
});
