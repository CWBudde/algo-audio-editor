/// <reference lib="dom" />
import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { select } from "./edit-fixture.js";
import { exportDownload, openExport, sourceState } from "./export-fixture.js";
import { captureKernelWorker } from "./kernel-probe.js";
import { revealControl } from "./ui-disclosures.js";

function tone(frames: number, rate = 48000) {
  const bytes = Buffer.alloc(44 + frames * 4);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 4, 28);
  bytes.writeUInt16LE(4, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++)
    for (let ch = 0; ch < 2; ch++)
      bytes.writeInt16LE(
        Math.round(12000 * Math.sin((2 * Math.PI * (ch ? 880 : 440) * i) / rate)),
        44 + i * 4 + ch * 2,
      );
  return bytes;
}
for (const scenario of [
  { frames: 17003, rate: 48000, selection: false },
  { frames: 17003, rate: 48000, selection: true },
  { frames: 960, rate: 48000, selection: false },
  { frames: 1, rate: 48000, selection: false },
]) {
  test(`Opus export ${scenario.rate} Hz ${scenario.frames} frames ${scenario.selection ? "right selection" : "stereo"}`, async ({
    page,
  }) => {
    await captureKernelWorker(page);
    await page.addInitScript(() => Object.assign(window, { showSaveFilePicker: undefined }));
    await page.goto("/");
    await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
    await page.getByTestId("audio-file-input").setInputFiles({
      name: "tone.wav",
      mimeType: "audio/wav",
      buffer: tone(scenario.frames, scenario.rate),
    });
    await expect(page.getByTestId("document-name")).toHaveText("tone.wav");
    if (scenario.selection) {
      await (await revealControl(page.getByLabel("Time format", { exact: true }))).selectOption(
        "samples",
      );
      await page.keyboard.press("Escape");
      await select(page, 100, 16999);
      await (
        await revealControl(
          page.getByRole("button", { name: "Right", exact: true, includeHidden: true }),
        )
      ).click();
      await page.keyboard.press("Escape");
    }
    const before = await sourceState(page);
    const dialog = await openExport(page);
    if (scenario.selection)
      await dialog.getByLabel("Range", { exact: true }).selectOption("selection");
    await expect(dialog.locator('option[value="opus"]')).toBeEnabled();
    await dialog.getByLabel("Format", { exact: true }).selectOption("opus");
    await dialog.getByLabel("Bitrate").selectOption("128");
    const { download, bytes } = await exportDownload(page);
    expect(download.suggestedFilename()).toBe(
      scenario.selection ? "tone-selection.opus" : "tone.opus",
    );
    expect(bytes.subarray(0, 4).toString()).toBe("OggS");
    await writeFile(test.info().outputPath("export.opus"), bytes);
    expect(await sourceState(page)).toEqual(before);
    const decoded = await page.evaluate(
      async ({ bytes, rate, frames, selection }) => {
        const audio = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(
          new Uint8Array(bytes).buffer,
        );
        let error = 0,
          power = 0;
        for (let ch = 0; ch < audio.numberOfChannels; ch++) {
          const data = audio.getChannelData(ch);
          for (let i = 960; i < Math.min(data.length - 960, (frames * 48000) / rate); i++) {
            const original =
              (12000 / 32768) *
              Math.sin(
                2 *
                  Math.PI *
                  (selection ? 880 : ch ? 880 : 440) *
                  (i / 48000 + (selection ? 100 / rate : 0)),
              );
            error += (data[i] - original) ** 2;
            power += original ** 2;
          }
        }
        return {
          rate: audio.sampleRate,
          channels: audio.numberOfChannels,
          frames: audio.length,
          snr: 10 * Math.log10(power / error),
        };
      },
      {
        bytes: Array.from(bytes),
        rate: scenario.rate,
        frames: scenario.selection ? 16899 : scenario.frames,
        selection: scenario.selection,
      },
    );
    expect(decoded.rate).toBe(48000);
    expect(decoded.channels).toBe(scenario.selection ? 1 : 2);
    expect(decoded.frames).toBe(
      Math.round(((scenario.selection ? 16899 : scenario.frames) * 48000) / scenario.rate),
    );
    if (scenario.frames > 1920) expect(decoded.snr).toBeGreaterThan(25);
    await page
      .getByTestId("audio-file-input")
      .setInputFiles({ name: "roundtrip.opus", mimeType: "audio/ogg", buffer: bytes });
    await expect(page.getByTestId("document-name")).toHaveText("roundtrip.opus");
  });
}
test("unavailable codec options track exact rate/channel support, and AAC exports when available", async ({
  page,
}) => {
  await captureKernelWorker(page);
  await page.addInitScript(() => Object.assign(window, { showSaveFilePicker: undefined }));
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
  await page
    .getByTestId("audio-file-input")
    .setInputFiles({ name: "tone.wav", mimeType: "audio/wav", buffer: tone(17003, 44100) });
  await expect(page.getByTestId("document-name")).toHaveText("tone.wav");
  const supported = await page.evaluate(
    async () =>
      typeof AudioEncoder !== "undefined" &&
      (
        await AudioEncoder.isConfigSupported({
          codec: "mp4a.40.2",
          sampleRate: 44100,
          numberOfChannels: 2,
          bitrate: 128000,
          aac: { format: "aac" },
        })
      ).supported,
  );
  const before = await sourceState(page),
    dialog = await openExport(page);
  await expect(dialog.locator('option[value="opus"]')).toHaveText("Ogg Opus (unavailable)");
  if (!supported) {
    await expect(dialog.locator('option[value="m4a"]')).toHaveText("M4A AAC (unavailable)");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    return;
  }
  await dialog.getByLabel("Format", { exact: true }).selectOption("m4a");
  const { download, bytes } = await exportDownload(page);
  expect(download.suggestedFilename()).toBe("tone.m4a");
  expect(bytes.toString("ascii", 4, 8)).toBe("ftyp");
  await writeFile(test.info().outputPath("export.m4a"), bytes);
  expect(await sourceState(page)).toEqual(before);
  await page
    .getByTestId("audio-file-input")
    .setInputFiles({ name: "roundtrip.m4a", mimeType: "audio/mp4", buffer: bytes });
  await expect(page.getByTestId("document-name")).toHaveText("roundtrip.m4a");
});

// Linux Chromium has no AAC encoder. Drive only its encoder boundary with
// independently encoded packets, then verify the real UI/muxer/browser decoder.
test("M4A muxes independent AAC packets into a playable file without changing source state", async ({
  page,
}) => {
  const { readFileSync } = await import("node:fs");
  const adts = readFileSync(
    new URL("../../../packages/kernel/internal/engine/testdata/codecs/tone.aac", import.meta.url),
  );
  const packets: number[][] = [];
  for (let offset = 0; offset < adts.length; ) {
    const size = ((adts[offset + 3] & 3) << 11) | (adts[offset + 4] << 3) | (adts[offset + 5] >> 5);
    const header = adts[offset + 1] & 1 ? 7 : 9;
    expect(size).toBeGreaterThan(header);
    packets.push(Array.from(adts.subarray(offset + header, offset + size)));
    offset += size;
  }
  await captureKernelWorker(page);
  await page.addInitScript((packets) => {
    class FixtureEncoder {
      static async isConfigSupported(config: AudioEncoderConfig) {
        return { supported: config.codec === "mp4a.40.2", config };
      }
      state = "unconfigured";
      encodeQueueSize = 0;
      init: AudioEncoderInit;
      constructor(init: AudioEncoderInit) {
        this.init = init;
      }
      configure() {
        this.state = "configured";
      }
      encode() {}
      async flush() {
        for (let i = 0; i < packets.length; i++)
          this.init.output(
            new EncodedAudioChunk({
              type: "key",
              timestamp: Math.round((i * 1024 * 1e6) / 44100),
              duration: Math.round((1024 * 1e6) / 44100),
              data: new Uint8Array(packets[i]),
            }),
            i === 0
              ? {
                  decoderConfig: {
                    codec: "mp4a.40.2",
                    sampleRate: 44100,
                    numberOfChannels: 2,
                    description: new Uint8Array([0x12, 0x10]),
                  },
                }
              : {},
          );
      }
      close() {
        this.state = "closed";
      }
    }
    Object.assign(window, { AudioEncoder: FixtureEncoder, showSaveFilePicker: undefined });
  }, packets);
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
  await page
    .getByTestId("audio-file-input")
    .setInputFiles({
      name: "tone.wav",
      mimeType: "audio/wav",
      buffer: readFileSync(
        new URL(
          "../../../packages/kernel/internal/engine/testdata/codecs/tone.wav",
          import.meta.url,
        ),
      ),
    });
  await expect(page.getByTestId("document-name")).toHaveText("tone.wav");
  const before = await sourceState(page),
    dialog = await openExport(page);
  await expect(dialog.locator('option[value="m4a"]')).toBeEnabled();
  await dialog.getByLabel("Format", { exact: true }).selectOption("m4a");
  const { bytes } = await exportDownload(page);
  await writeFile(test.info().outputPath("fixture.m4a"), bytes);
  expect(bytes.toString("ascii", 4, 8)).toBe("ftyp");
  expect(await sourceState(page)).toEqual(before);
  const decoded = await page.evaluate(
    async ({ mp4, adts }) => {
      const context = new OfflineAudioContext(1, 1, 44100);
      const a = await context.decodeAudioData(new Uint8Array(mp4).buffer),
        b = await context.decodeAudioData(new Uint8Array(adts).buffer);
      let delta = 0;
      for (let ch = 0; ch < 2; ch++) {
        const x = a.getChannelData(ch),
          y = b.getChannelData(ch);
        for (let i = 0; i < Math.min(x.length, y.length); i++)
          delta = Math.max(delta, Math.abs(x[i] - y[i]));
      }
      return {
        rate: a.sampleRate,
        channels: a.numberOfChannels,
        frames: a.length,
        referenceFrames: b.length,
        delta,
      };
    },
    { mp4: Array.from(bytes), adts: Array.from(adts) },
  );
  expect(decoded).toMatchObject({ rate: 44100, channels: 2, frames: decoded.referenceFrames });
  expect(decoded.delta).toBeLessThan(1e-6);
});
