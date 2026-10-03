import { describe, expect, it } from "vitest";
import { sampleViewportRange } from "./waveform-samples";

describe("sample viewport requests", () => {
  it("uses the strict CSS pixel threshold and adds bounded boundary context", () => {
    expect(sampleViewportRange({ start: 10, end: 20 }, 100, 9)).toBeUndefined();
    expect(sampleViewportRange({ start: 10, end: 20 }, 100, 10)).toBeUndefined();
    expect(sampleViewportRange({ start: 10, end: 20 }, 100, 10.001)).toEqual({ start: 9, end: 21 });
    // DPR changes backing pixels, not this CSS threshold.
    expect(sampleViewportRange({ start: 0, end: 100 }, 100, 100)).toBeUndefined();
    expect(sampleViewportRange({ start: 0, end: 1 }, 1, 50)).toEqual({ start: 0, end: 1 });
    expect(sampleViewportRange({ start: 0, end: 8 }, 20, 100)).toEqual({ start: 0, end: 9 });
    expect(sampleViewportRange({ start: 12, end: 20 }, 20, 100)).toEqual({ start: 11, end: 20 });
  });

  it("retains safe high offsets and clamps neighbors before paging", () => {
    const last = Number.MAX_SAFE_INTEGER;
    expect(sampleViewportRange({ start: last - 1, end: last }, last, 2)).toEqual({
      start: last - 2,
      end: last,
    });
    expect(sampleViewportRange({ start: 2 ** 32, end: 2 ** 32 + 8 }, 2 ** 32 + 20, 100)).toEqual({
      start: 2 ** 32 - 1,
      end: 2 ** 32 + 9,
    });
    //8191 visible points plus2 context points must not be truncated to one page.
    expect(sampleViewportRange({ start: 1, end: 8192 }, 9000, 9000)).toEqual({
      start: 0,
      end: 8193,
    });
  });

  it.each([
    [{ start: 0, end: 0 }, 0, 100],
    [{ start: -1, end: 1 }, 10, 100],
    [{ start: 3, end: 2 }, 10, 100],
    [{ start: 0, end: 11 }, 10, 100],
    [{ start: 0.5, end: 2 }, 10, 100],
    [{ start: 0, end: Number.MAX_SAFE_INTEGER + 1 }, Number.MAX_SAFE_INTEGER + 1, Infinity],
    [{ start: 0, end: 2 }, 10, Number.NaN],
    [{ start: 0, end: 2 }, 10, Infinity],
    [{ start: 0, end: 2 }, 10, 0],
  ])("rejects invalid/empty sample geometry %#", (viewport, total, width) => {
    expect(sampleViewportRange(viewport, total, width)).toBeUndefined();
  });
});
