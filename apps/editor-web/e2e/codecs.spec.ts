/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { DocumentInfoResult } from "../../../packages/protocol/src/index.js";
import { exportDownload, openExport, wavChunk } from "./export-fixture.js";
import { captureKernelWorker } from "./kernel-probe.js";

const fixture = (format: string) =>
  readFileSync(
    new URL(
      `../../../packages/kernel/internal/engine/testdata/codecs/${format === "96k.m4a" ? "tone-96k.m4a" : `tone.${format}`}`,
      import.meta.url,
    ),
  );
for (const format of ["flac", "aiff", "mp3", "ogg", "opus", "m4a", "96k.m4a"]) {
  test(`imports ${format} by magic at its original sample rate`, async ({ page }) => {
    await captureKernelWorker(page);
    await page.goto("/");
    await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
    // First import an existing document to exercise atomic browser PCM replacement.
    await page
      .getByTestId("audio-file-input")
      .setInputFiles({ name: "previous.wav", mimeType: "audio/wav", buffer: fixture("wav") });
    await expect(page.getByTestId("document-name")).toHaveText("previous.wav");
    await page.getByTestId("audio-file-input").setInputFiles({
      name: "renamed.bin",
      mimeType: "application/octet-stream",
      buffer: fixture(format),
    });
    await expect(page.getByTestId("document-name")).toHaveText("renamed.bin");
    const info = await page.evaluate(
      async () => (await window.__aaeTest?.request("doc.info")) as DocumentInfoResult,
    );
    expect(info.sampleRate).toBe(format === "opus" ? 48000 : format === "96k.m4a" ? 96000 : 44100);
    expect(info.channels).toBe(2);
    if (["ogg", "opus", "m4a", "96k.m4a"].includes(format)) {
      // Compare with the browser decoder's exact output, including its handling
      // of codec delay/padding, then verify the kernel received every sample.
      const expected = await page.evaluate(
        async ({ bytes, rate }) => {
          const decoded = await new OfflineAudioContext(1, 1, rate).decodeAudioData(
            new Uint8Array(bytes).buffer,
          );
          const pcm = new Float32Array(decoded.length * decoded.numberOfChannels);
          for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
            const plane = decoded.getChannelData(ch);
            for (let i = 0; i < decoded.length; i++)
              pcm[i * decoded.numberOfChannels + ch] = plane[i];
          }
          return {
            frames: decoded.length,
            hash: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", pcm.buffer))),
          };
        },
        { bytes: Array.from(fixture(format)), rate: info.sampleRate },
      );
      expect(info.frames).toBe(expected.frames);
      const actual = await page.evaluate(async () => {
        const result = (await window.__aaeTest?.request("doc.export", {
          format: "wav",
          bitDepth: 32,
          float: true,
        })) as { data: ArrayBuffer };
        const view = new DataView(result.data);
        for (let offset = 12; offset + 8 <= result.data.byteLength; ) {
          const size = view.getUint32(offset + 4, true);
          if (String.fromCharCode(...new Uint8Array(result.data, offset, 4)) === "data")
            return Array.from(
              new Uint8Array(
                await crypto.subtle.digest(
                  "SHA-256",
                  result.data.slice(offset + 8, offset + 8 + size),
                ),
              ),
            );
          offset += 8 + size + (size % 2);
        }
        throw new Error("missing PCM");
      });
      expect(actual).toEqual(expected.hash);
    } else expect(info.frames).toBeGreaterThan(4000);
    if (format === "flac" || format === "aiff") {
      expect(info.frames).toBe(4097);
      const pcm = await page.evaluate(async () => {
        const data = (await window.__aaeTest?.request("doc.export", {
          format: "wav",
          bitDepth: 16,
          float: false,
        })) as { data: ArrayBuffer };
        return Array.from(new Uint8Array(data.data));
      });
      expect(wavChunk(Buffer.from(pcm), "data")).toEqual(wavChunk(fixture("wav"), "data"));
    }
    await page.getByTestId("audio-file-input").setInputFiles({
      name: "damaged.flac",
      mimeType: "audio/flac",
      buffer: fixture("flac").subarray(0, 50),
    });
    await expect(page.getByText("Could not open audio", { exact: true })).toBeVisible();
    await expect(page.getByTestId("document-name")).toHaveText("renamed.bin");
  });
}
for (const format of ["flac", "aiff"]) {
  test(`exports ${format} through the dialog and reimports exact samples`, async ({ page }) => {
    await captureKernelWorker(page);
    await page.addInitScript(() => Object.assign(window, { showSaveFilePicker: undefined }));
    await page.goto("/");
    await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
    await page
      .getByTestId("audio-file-input")
      .setInputFiles({ name: "tone.wav", mimeType: "audio/wav", buffer: fixture("wav") });
    await expect(page.getByTestId("document-name")).toHaveText("tone.wav");
    const dialog = await openExport(page);
    await dialog.getByLabel("Format", { exact: true }).selectOption(format);
    await dialog.getByLabel("Bit depth").selectOption("16");
    const { download, bytes } = await exportDownload(page);
    expect(download.suggestedFilename()).toBe(`tone.${format}`);
    await writeFile(test.info().outputPath(`export.${format}`), bytes);
    await page.getByTestId("audio-file-input").setInputFiles({
      name: download.suggestedFilename(),
      mimeType: `audio/${format}`,
      buffer: bytes,
    });
    await expect(page.getByTestId("document-name")).toHaveText(`tone.${format}`);
    const pcm = await page.evaluate(async () => {
      const result = (await window.__aaeTest?.request("doc.export", {
        format: "wav",
        bitDepth: 16,
        float: false,
      })) as { data: ArrayBuffer };
      return Array.from(new Uint8Array(result.data));
    });
    expect(wavChunk(Buffer.from(pcm), "data")).toEqual(wavChunk(fixture("wav"), "data"));
  });
}
