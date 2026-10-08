import { expect, it } from "vitest";
import { waveformLaneHeight } from "./lane-layout";

it("fills mono and stereo workspaces and shares each split channel between two panels", () => {
  expect(waveformLaneHeight(720, 1, false)).toBe(719);
  expect(waveformLaneHeight(720, 2, false)).toBe(359);
  expect(waveformLaneHeight(720, 2, true)).toBe(167);
});

it("reserves only the spectral readout footer and keeps waveform-only image geometry unchanged", () => {
  expect(waveformLaneHeight(720, 2, false, true)).toBe(335);
  expect(waveformLaneHeight(720, 2, false, false)).toBe(359);
  expect(waveformLaneHeight(720, 2, true, true)).toBe(167);
  expect(waveformLaneHeight(720, 2, true, false)).toBe(179);
  expect(waveformLaneHeight(120, 2, true, true)).toBe(96);
  expect(waveformLaneHeight(0, 2, false, true)).toBe(160);
});

it("keeps dense and small workspaces legible, bounds large canvases and tolerates initial measurement", () => {
  expect(waveformLaneHeight(720, 8, false)).toBe(96);
  expect(waveformLaneHeight(80, 2, true)).toBe(96);
  expect(waveformLaneHeight(5000, 1, false)).toBe(1024);
  for (const height of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
    expect(waveformLaneHeight(height, 2, false)).toBe(160);
});
