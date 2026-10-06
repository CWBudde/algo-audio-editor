import { expect, it } from "vitest";
import { waveformLaneHeight } from "./lane-layout";

it("fills mono and stereo workspaces and shares each split channel between two panels", () => {
  expect(waveformLaneHeight(720, 1, false)).toBe(695);
  expect(waveformLaneHeight(720, 2, false)).toBe(335);
  expect(waveformLaneHeight(720, 2, true)).toBe(167);
});

it("keeps dense and small workspaces legible, bounds large canvases and tolerates initial measurement", () => {
  expect(waveformLaneHeight(720, 8, false)).toBe(96);
  expect(waveformLaneHeight(80, 2, true)).toBe(96);
  expect(waveformLaneHeight(5000, 1, false)).toBe(1024);
  for (const height of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
    expect(waveformLaneHeight(height, 2, false)).toBe(160);
});
