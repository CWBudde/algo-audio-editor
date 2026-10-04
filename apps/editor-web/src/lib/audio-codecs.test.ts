import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import type { KernelClient } from "@/kernel/client";
import { encodedSampleRate, openAudioDocument, usesKernelCodec } from "./audio-codecs";
import {
  defaultExportSettings,
  exportName,
  exportParams,
  updateExportSettings,
} from "./export-settings";

const fixture = (format: string) =>
  Uint8Array.from(
    readFileSync(`../../packages/kernel/internal/engine/testdata/codecs/tone.${format}`),
  ).buffer;
afterEach(() => vi.unstubAllGlobals());
it("routes by magic, including ID3, independently of extensions", () => {
  for (const format of ["wav", "flac", "aiff", "mp3"])
    expect(usesKernelCodec(fixture(format))).toBe(true);
  for (const format of ["ogg", "opus", "m4a"]) expect(usesKernelCodec(fixture(format))).toBe(false);
  const raw = new Uint8Array(14);
  raw.set([73, 68, 51, 4, 0, 0, 0, 0, 0, 0, 102, 76, 97, 67]);
  expect(usesKernelCodec(raw.buffer)).toBe(true);
  expect(usesKernelCodec(new Uint8Array([73, 68, 51]).buffer)).toBe(true);
});
it("reads original container rates without guessing from filenames", () => {
  expect(encodedSampleRate(fixture("ogg"))).toBe(44100);
  expect(encodedSampleRate(fixture("opus"))).toBe(48000);
  expect(encodedSampleRate(fixture("m4a"))).toBe(44100);
  const highRate = Uint8Array.from(
    readFileSync("../../packages/kernel/internal/engine/testdata/codecs/tone-96k.m4a"),
  ).buffer;
  expect(encodedSampleRate(highRate)).toBe(96000);
  expect(encodedSampleRate(new Uint8Array([255, 241, 80, 128, 0, 0, 0]).buffer)).toBe(44100);
  expect(
    encodedSampleRate(new TextEncoder().encode("garbage OpusHead garbage").buffer),
  ).toBeUndefined();
  for (const format of ["ogg", "m4a"]) {
    const raw = fixture(format);
    for (const length of [0, 1, 6, 12, 24])
      expect(() => encodedSampleRate(raw.slice(0, length))).not.toThrow();
  }
});
it("copies native-rate browser PCM to a binary kernel call", async () => {
  const planes = [new Float32Array([0.25, -0.5]), new Float32Array([0.75, -1])];
  const decode = vi.fn().mockResolvedValue({
    sampleRate: 44100,
    numberOfChannels: 2,
    length: 2,
    getChannelData: (ch: number) => planes[ch],
  });
  // biome-ignore lint/complexity/useArrowFunction: mocked constructor must be constructible.
  const context = vi.fn(function () {
    return { decodeAudioData: decode };
  });
  vi.stubGlobal("OfflineAudioContext", context);
  const open = vi.fn().mockResolvedValue({ documentId: "new" });
  const client = { openPCMDocument: open } as unknown as KernelClient;
  await openAudioDocument(client, "renamed.bin", fixture("ogg"), () => true);
  expect(context).toHaveBeenCalledWith(1, 1, 44100);
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({ name: "renamed.bin", sampleRate: 44100, channels: 2, frames: 2 }),
    expect.any(ArrayBuffer),
  );
  expect(Array.from(new Float32Array(open.mock.calls[0][1]))).toEqual([0.25, -0.5, 0.75, -1]);
});
it("rejects browser decoder failure, oversized PCM and stale completion without replacing the document", async () => {
  const open = vi.fn();
  const decode = vi.fn().mockRejectedValue(new Error("bad codec"));
  vi.stubGlobal(
    "OfflineAudioContext",
    // biome-ignore lint/complexity/useArrowFunction: mocked constructor must be constructible.
    vi.fn(function () {
      return { decodeAudioData: decode };
    }),
  );
  const client = { openPCMDocument: open } as unknown as KernelClient;
  await expect(openAudioDocument(client, "bad.ogg", fixture("ogg"), () => true)).rejects.toThrow(
    "unsupported or damaged",
  );
  decode.mockResolvedValue({ sampleRate: 44100, numberOfChannels: 2, length: 1e9 });
  await expect(openAudioDocument(client, "large.ogg", fixture("ogg"), () => true)).rejects.toThrow(
    "memory limit",
  );
  expect(await openAudioDocument(client, "old.ogg", fixture("ogg"), () => false)).toBeUndefined();
  expect(open).not.toHaveBeenCalled();
});
it("defaults from detected source format, constrains FLAC export, and suggests real output extensions", () => {
  const info = {
    documentId: "d",
    name: "misleading.mp3",
    format: "flac" as const,
    sampleRate: 48000,
    channels: 2,
    frames: 1,
    bitDepth: 24,
    float: false,
  };
  const settings = defaultExportSettings(info);
  expect(settings.format).toBe("flac");
  expect(exportName(info.name, "flac")).toBe("misleading.flac");
  expect(
    updateExportSettings({ ...settings, bitDepth: 32 }, { format: "flac", encoding: "float" }),
  ).toMatchObject({ bitDepth: 24, encoding: "pcm" });
  expect(
    exportParams(info, { start: 0, end: 1, channelMask: 3 }, { ...settings, bitDepth: 32 }),
  ).toBeUndefined();
});
