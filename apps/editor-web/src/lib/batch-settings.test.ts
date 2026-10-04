import { expect, it } from "vitest";
import { batchOutputNames, DEFAULT_BATCH_SETTINGS, updateBatchSettings } from "./batch-settings";

it("derives CLI-compatible suffix names and normalizes encoding choices", () => {
  expect(
    batchOutputNames(
      [{ name: "Podcast.Final.WAV" }, { name: "voice.aif" }],
      DEFAULT_BATCH_SETTINGS,
    ),
  ).toEqual(["Podcast.Final-processed.flac", "voice-processed.flac"]);
  const float = updateBatchSettings(DEFAULT_BATCH_SETTINGS, { format: "wav", encoding: "float" });
  expect(float.bitDepth).toBe(32);
  expect(updateBatchSettings(float, { format: "aiff" })).toEqual({
    format: "aiff",
    encoding: "pcm",
    bitDepth: 32,
    suffix: "-processed",
  });
  expect(updateBatchSettings(float, { format: "flac" }).bitDepth).toBe(16);
});

it("rejects unsafe, duplicate and nonportable output names before file access", () => {
  for (const suffix of ["../out", "\\out", "bad?", "bad\u0000"])
    expect(() =>
      batchOutputNames([{ name: "voice.wav" }], { ...DEFAULT_BATCH_SETTINGS, suffix }),
    ).toThrow("suffix");
  for (const name of ["../voice.wav", "a:b.wav", "a".repeat(260)])
    expect(() => batchOutputNames([{ name }], DEFAULT_BATCH_SETTINGS)).toThrow("Invalid output");
  expect(() =>
    batchOutputNames([{ name: "CON.wav" }], { ...DEFAULT_BATCH_SETTINGS, suffix: "" }),
  ).toThrow("Invalid output");
  expect(() =>
    batchOutputNames([{ name: "a.wav" }, { name: "A.flac" }], DEFAULT_BATCH_SETTINGS),
  ).toThrow("Duplicate");
  expect(() =>
    batchOutputNames([{ name: "e\u0301.wav" }, { name: "é.wav" }], DEFAULT_BATCH_SETTINGS),
  ).toThrow("Duplicate");
});
