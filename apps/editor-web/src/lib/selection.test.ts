import { describe, expect, it } from "vitest";
import {
  allChannelsMask,
  extendSelection,
  formatSelectionTime,
  parseSelectionTime,
  snapSelectionFrame,
} from "./selection";
import type { TimeFormat } from "./waveform-geometry";

describe("exact selection time", () => {
  const formats: TimeFormat[] = ["samples", "seconds", "hms"];
  it("round-trips safe integer positions at low, prime and high sample rates", () => {
    const frames = [
      0,
      1,
      2,
      127,
      384001,
      2 ** 32 + 1,
      Number.MAX_SAFE_INTEGER - 2,
      Number.MAX_SAFE_INTEGER - 1,
      Number.MAX_SAFE_INTEGER,
    ];
    for (const rate of [1, 3, 7, 8000, 11025, 44100, 48000, 383999, 384000]) {
      for (const frame of frames) {
        for (const format of formats)
          expect(
            parseSelectionTime(formatSelectionTime(frame, rate, format), rate, format),
            `${frame}/${rate}/${format}`,
          ).toBe(frame);
      }
    }
  });

  it("keeps neighboring frames distinct at 384 kHz rather than rounding to milliseconds", () => {
    expect(formatSelectionTime(1, 384000, "seconds")).toBe("0.000002604");
    expect(formatSelectionTime(2, 384000, "hms")).toBe("0:00:00.000005208");
    expect(formatSelectionTime(Number.MAX_SAFE_INTEGER, 1, "seconds")).toBe("9007199254740991");
    expect(formatSelectionTime(3661 * 48000 + 24000, 48000, "hms")).toBe("1:01:01.500");
  });

  it("parses grouped samples, fractional seconds and precise clock text", () => {
    expect(parseSelectionTime(" 9,007,199,254,740,991 ", 48000, "samples")).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(parseSelectionTime("1.5 s", 48000, "seconds")).toBe(72000);
    expect(parseSelectionTime("0:01:00.000002604", 384000, "hms")).toBe(23040001);
    expect(parseSelectionTime("0.5", 1, "seconds")).toBe(1);
    expect(parseSelectionTime("0.499999999999999999", 1, "seconds")).toBe(0);
    expect(parseSelectionTime("0.000001302083333334", 384000, "seconds")).toBe(1);
  });

  it.each([
    "",
    " ",
    "-1",
    "+1",
    "1.5",
    "1e3",
    "1,00",
    "1234,567",
    "1,234,",
    "NaN",
    "9007199254740992",
  ])("rejects malformed or overflowing samples %s", (text) => {
    expect(parseSelectionTime(text, 48000, "samples")).toBeUndefined();
  });
  it.each([
    "-0.1",
    "1e10",
    ".5",
    "1.",
    "1,000.5",
    "Infinity",
    "1.0000000000000000001",
    "9007199254740992",
  ])("rejects malformed or overflowing seconds %s", (text) => {
    expect(parseSelectionTime(text, 1, "seconds")).toBeUndefined();
  });
  it.each([
    "1:2:3",
    "00:60:00",
    "0:00:60",
    "0:00:00.",
    "-1:00:00",
    "1:00",
    "1:00:00:00",
    "2501999792984:00:00",
  ])("rejects malformed or overflowing clock time %s", (text) => {
    expect(parseSelectionTime(text, 1, "hms")).toBeUndefined();
  });
  it.each([0, -1, 0.5, 48000.5, 384001, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects unsupported rate %s",
    (rate) => {
      expect(parseSelectionTime("1", rate, "seconds")).toBeUndefined();
      expect(() => formatSelectionTime(1, rate, "seconds")).toThrow(RangeError);
    },
  );
  it("rejects invalid frame arguments and excessive input lengths", () => {
    for (const frame of [
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ])
      expect(() => formatSelectionTime(frame, 48000, "samples")).toThrow(RangeError);
    expect(parseSelectionTime("1".repeat(129), 1, "seconds")).toBeUndefined();
  });
});

describe("selection coordinates and channels", () => {
  it("snaps to nearest candidate within inclusive threshold, preferring earlier ties", () => {
    expect(snapSelectionFrame(50, [55, 45], 5, 100)).toBe(45);
    expect(snapSelectionFrame(50, [45, 53, 55], 5, 100)).toBe(53);
    expect(snapSelectionFrame(50, [49, 55], 0, 100)).toBe(50);
    expect(snapSelectionFrame(50, [50], 0, 100)).toBe(50);
  });
  it("clamps coordinates and ignores invalid or out-of-document candidates", () => {
    expect(snapSelectionFrame(-50, [-1, 2, 101, Number.NaN], 3, 100)).toBe(2);
    expect(snapSelectionFrame(105, [99, Number.POSITIVE_INFINITY], 1, 100)).toBe(99);
    expect(snapSelectionFrame(50.4, [49.5], 5, 100)).toBe(50);
    expect(snapSelectionFrame(50, [49], -1, 100)).toBe(50);
    expect(snapSelectionFrame(50, [49], Number.NaN, 100)).toBe(50);
    expect(snapSelectionFrame(Number.NaN, [5], 0, 100)).toBe(0);
    expect(snapSelectionFrame(20, [5], 10, 0)).toBe(0);
    expect(
      snapSelectionFrame(
        Number.MAX_SAFE_INTEGER,
        [Number.MAX_SAFE_INTEGER - 1],
        1,
        Number.MAX_SAFE_INTEGER,
      ),
    ).toBe(Number.MAX_SAFE_INTEGER - 1);
  });
  it("extends either side from a stable anchor without changing selected channels", () => {
    const selection = { start: 10, end: 20, channelMask: 2 };
    expect(extendSelection(selection, 30)).toEqual({ start: 10, end: 30, channelMask: 2 });
    expect(extendSelection(selection, 5, 20)).toEqual({ start: 5, end: 20, channelMask: 2 });
    expect(selection).toEqual({ start: 10, end: 20, channelMask: 2 });
  });
  it("forms every supported channel mask without a signed-bit surprise", () => {
    expect(allChannelsMask(1)).toBe(1);
    expect(allChannelsMask(2)).toBe(3);
    expect(allChannelsMask(8)).toBe(255);
    for (const channels of [0, 1.5, 9, Number.NaN])
      expect(() => allChannelsMask(channels)).toThrow(RangeError);
  });
});
