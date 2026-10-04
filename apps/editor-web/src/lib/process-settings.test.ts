import type { DocumentInfoResult } from "@aae/protocol";
import { expect, it } from "vitest";
import { defaultProcessSettings, processParams, processSettingsKey } from "./process-settings";

const info: DocumentInfoResult = {
  documentId: "d",
  name: "source",
  sampleRate: 48000,
  channels: 2,
  frames: 96000,
  bitDepth: 32,
  float: true,
};
const range = { start: 1000, end: 2000, channelMask: 2 };
const settings = defaultProcessSettings(info, 123);

it("uses explicit fade shape and rejects crossfade overlap without two complete sides", () => {
  expect(processParams(info, range, "fade-out", "", settings)).toMatchObject({
    operation: "fade-out",
    curve: "linear",
    ...range,
  });
  const cursor = { ...range, start: 1000, end: 1000 };
  expect(
    processParams(info, cursor, "crossfade", "", { ...settings, durationText: "0.01" }),
  ).toMatchObject({ durationFrames: 480, curve: "linear" });
  expect(processParams(info, range, "crossfade", "", settings)).toBeUndefined();
  for (const durationText of ["0", "-1", "NaN", "1", String(1 / info.sampleRate)])
    expect(
      processParams(info, cursor, "crossfade", "", { ...settings, durationText }),
    ).toBeUndefined();
});

it("requires valid source channel counts and integer supported sample rates", () => {
  expect(processParams(info, range, "mono-to-stereo", "", settings)).toBeUndefined();
  expect(
    processParams(
      { ...info, channels: 1 },
      { ...range, channelMask: 1 },
      "mono-to-stereo",
      "",
      settings,
    ),
  ).toMatchObject({ operation: "mono-to-stereo" });
  expect(
    processParams(info, range, "stereo-to-mono", "", { ...settings, channelMode: "right" }),
  ).toMatchObject({ channelMode: "right" });
  expect(
    processParams(info, range, "resample", "", { ...settings, sampleRateText: "44100" }),
  ).toMatchObject({ sampleRate: 44100, quality: "balanced" });
  for (const sampleRateText of ["", "7999", "384001", "44100.5", "Infinity"])
    expect(
      processParams(info, range, "resample", "", { ...settings, sampleRateText }),
    ).toBeUndefined();
});

it("uses cursor duration or exact selected length and retains the resolved noise seed", () => {
  const noise = { ...settings, generator: "pink-noise" as const };
  const inserted = processParams(
    { ...info, frames: 0 },
    { start: 0, end: 0, channelMask: 2 },
    "generate",
    "",
    noise,
  );
  expect(inserted).toMatchObject({
    durationFrames: 48000,
    generator: "pink-noise",
    levelDb: -12,
    seed: 123,
    channelMask: 2,
  });
  expect(processSettingsKey(inserted ?? fail())).toBe(
    processSettingsKey(
      processParams(
        { ...info, frames: 0 },
        { start: 0, end: 0, channelMask: 2 },
        "generate",
        "",
        noise,
      ) ?? fail(),
    ),
  );
  expect(
    processParams(info, range, "generate", "", { ...noise, durationText: "invalid" }),
  ).toMatchObject({ durationFrames: 1000 });
  expect(
    processParams(info, { ...range, end: range.start }, "generate", "", {
      ...noise,
      durationText: "invalid",
    }),
  ).toBeUndefined();
});

it("validates only the controls required by the chosen generator", () => {
  expect(
    processParams(info, range, "generate", "", {
      ...settings,
      generator: "silence",
      levelText: "bad",
      frequencyText: "bad",
    }),
  ).toMatchObject({ generator: "silence" });
  expect(
    processParams(info, range, "generate", "", {
      ...settings,
      generator: "white-noise",
      frequencyText: "bad",
    }),
  ).toMatchObject({ generator: "white-noise" });
  for (const frequencyText of ["0", "-1", "24001", "NaN"])
    expect(
      processParams(info, range, "generate", "", { ...settings, frequencyText }),
    ).toBeUndefined();
  expect(
    processParams(info, range, "generate", "", {
      ...settings,
      generator: "log-sweep",
      endFrequencyText: "0",
    }),
  ).toBeUndefined();
  expect(
    processParams(info, range, "generate", "", {
      ...settings,
      generator: "linear-sweep",
      frequencyText: "2000",
      endFrequencyText: "20",
    }),
  ).toMatchObject({ frequency: 2000, endFrequency: 20 });
});

it("bounds extracted channel index independently of the selected channel mask", () => {
  expect(
    processParams(info, range, "extract-channel", "", { ...settings, channel: 0 }),
  ).toMatchObject({ channel: 0, channelMask: 2 });
  for (const channel of [-1, 2, 0.5])
    expect(
      processParams(info, range, "extract-channel", "", { ...settings, channel }),
    ).toBeUndefined();
});

function fail(): never {
  throw new Error("Expected valid parameters");
}

it("requires a current noise profile and spectral geometry, and keys every restoration setting", () => {
  const selected = { start: 4000, end: 4004, channelMask: 2 };
  const spectralMask = { start: 4000, end: 4004, lowHz: 300, highHz: 600 };
  expect(
    processParams(info, selected, "spectral-heal", "", { ...settings, spectralMask }),
  ).toMatchObject({ operation: "spectral-heal", spectralMask });
  expect(
    processParams(info, range, "spectral-heal", "", { ...settings, spectralMask }),
  ).toBeUndefined();
  expect(
    processParams(info, selected, "spectral-attenuate", "1", { ...settings, spectralMask }),
  ).toBeUndefined();
  expect(
    processParams(info, selected, "spectral-attenuate", "-12", { ...settings, spectralMask }),
  ).toMatchObject({ gainDb: -12 });
  expect(
    processParams(info, selected, "spectral-remove", "", { ...settings, spectralMask, fftSize: 3 }),
  ).toBeUndefined();
  const noiseProfile = { documentId: info.documentId, start: 0, end: 4800, channelMask: 3 };
  const p = processParams(info, range, "noise-reduce", "", { ...settings, noiseProfile });
  expect(p).toMatchObject({ reductionDb: 24, noiseMethod: "wiener", noiseProfile });
  for (const profile of [
    undefined,
    { ...noiseProfile, documentId: "stale" },
    { ...noiseProfile, channelMask: 1 },
    { ...noiseProfile, end: 3 },
  ])
    expect(
      processParams(info, range, "noise-reduce", "", { ...settings, noiseProfile: profile }),
    ).toBeUndefined();
  const changed = processParams(info, range, "noise-reduce", "", {
    ...settings,
    noiseProfile,
    reductionText: "12",
  });
  expect(processSettingsKey(p ?? fail())).not.toBe(processSettingsKey(changed ?? fail()));
});
it("validates duration, hum and short-gap limits before submitting restoration", () => {
  expect(
    processParams(info, { ...range, channelMask: 3 }, "time-stretch", "", settings),
  ).toMatchObject({ durationRatio: 1.25 });
  expect(processParams(info, range, "time-stretch", "", settings)).toBeUndefined();
  for (const ratioText of ["", "0.24", "4.01", "NaN"])
    expect(
      processParams(info, { ...range, channelMask: 3 }, "time-stretch", "", {
        ...settings,
        ratioText,
      }),
    ).toBeUndefined();
  expect(processParams(info, range, "remove-hum", "", settings)).toMatchObject({
    humHz: 50,
    humQ: 30,
    harmonics: 8,
  });
  expect(processParams(info, range, "remove-clicks", "", settings)).toMatchObject({
    sensitivity: 8,
    maxGap: 64,
  });
  expect(processParams(info, range, "declip", "", settings)).toMatchObject({ clipThreshold: 0.99 });
  for (const maxGapText of ["0", "257", "1.5", "NaN"])
    expect(processParams(info, range, "declip", "", { ...settings, maxGapText })).toBeUndefined();
  expect(
    processParams(info, range, "remove-hum", "", { ...settings, harmonicsText: "17" }),
  ).toBeUndefined();
});
