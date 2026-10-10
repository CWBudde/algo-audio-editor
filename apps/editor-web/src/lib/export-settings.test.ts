import type { DocumentInfoResult } from "@aae/protocol";
import { expect, it } from "vitest";
import { defaultExportSettings, exportParams, updateExportSettings } from "./export-settings";

const source = (change: Partial<DocumentInfoResult>): DocumentInfoResult => ({
  documentId: "doc-1",
  name: "take.wav",
  format: "wav",
  sampleRate: 48000,
  channels: 2,
  frames: 480,
  bitDepth: 24,
  float: false,
  ...change,
});
const all = { start: 0, end: 480, channelMask: 3 };

it("keeps dither off by default, as Save and batch export need", () => {
  for (const info of [source({}), source({ bitDepth: 16 }), source({ bitDepth: 32, float: true })])
    expect(defaultExportSettings(info).dither).toBe("none");
});

it.each([
  ["24-bit to 16-bit", source({}), { bitDepth: 16 }, "triangular"],
  ["24-bit to 8-bit", source({}), { bitDepth: 8 }, "triangular"],
  [
    "float to 16-bit PCM",
    source({ bitDepth: 32, float: true }),
    { encoding: "pcm" as const, bitDepth: 16 },
    "triangular",
  ],
  ["16-bit to 16-bit", source({ bitDepth: 16 }), { bitDepth: 16 }, "none"],
  ["24-bit to 24-bit", source({}), { bitDepth: 24 }, "none"],
  ["24-bit to 16-bit FLAC", source({}), { format: "flac" as const, bitDepth: 16 }, "triangular"],
  ["16-bit to float", source({ bitDepth: 16 }), { encoding: "float" as const }, "none"],
  ["24-bit to Opus", source({}), { format: "opus" as const }, "none"],
] as const)("dithers %s only when the export reduces resolution", (_, info, change, dither) => {
  const settings = updateExportSettings(defaultExportSettings(info, { dither: "auto" }), change);
  expect(settings.dither).toBe(dither);
  if (settings.format !== "opus") expect(exportParams(info, all, settings)?.dither).toBe(dither);
});

it("starts from the automatic choice for the source's own depth", () => {
  expect(defaultExportSettings(source({ bitDepth: 16 }), { dither: "auto" }).dither).toBe("none");
  // A 32-bit integer WAV keeps its depth, so it needs no dither either.
  expect(defaultExportSettings(source({ bitDepth: 32 }), { dither: "auto" }).dither).toBe("none");
});

it("keeps an explicit dither choice across later format and depth changes", () => {
  const info = source({});
  let settings = defaultExportSettings(info, { dither: "auto" });
  settings = updateExportSettings(settings, { dither: "rectangular" });
  settings = updateExportSettings(settings, { bitDepth: 16 });
  expect(settings.dither).toBe("rectangular");
  settings = updateExportSettings(settings, { dither: "none" });
  settings = updateExportSettings(settings, { bitDepth: 8 });
  expect(settings.dither).toBe("none");
});

it.each([
  ["source", source({ format: "flac", bitDepth: 16 }), "flac", "pcm", 16],
  ["wav", source({ format: "flac", bitDepth: 16 }), "wav", "pcm", 16],
  ["flac", source({ bitDepth: 32, float: true }), "flac", "pcm", 24],
  ["aiff", source({ bitDepth: 24 }), "aiff", "pcm", 24],
] as const)("applies the preferred %s export format", (format, info, want, encoding, depth) => {
  expect(defaultExportSettings(info, { format })).toMatchObject({
    format: want,
    encoding,
    bitDepth: depth,
  });
});

it("applies an explicit preferred dither, still cleared for float output", () => {
  expect(defaultExportSettings(source({ bitDepth: 16 }), { dither: "gaussian" }).dither).toBe(
    "gaussian",
  );
  expect(
    defaultExportSettings(source({ bitDepth: 32, float: true }), { dither: "gaussian" }).dither,
  ).toBe("none");
});
