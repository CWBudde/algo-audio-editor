import { describe, expect, it } from "vitest";
import {
  amplitudeToY,
  clampViewport,
  formatAmplitude,
  formatTime,
  frameToX,
  generateAmplitudeTicks,
  generateTimeTicks,
  panViewport,
  xToFrame,
  zoomViewport,
} from "./waveform-geometry";

describe("waveform viewport geometry", () => {
  it("handles empty, one-frame, reversed and off-file viewports", () => {
    expect(clampViewport({ start: 12, end: 50 }, 0)).toEqual({ start: 0, end: 0 });
    expect(clampViewport({ start: -100, end: 100 }, 1)).toEqual({ start: 0, end: 1 });
    expect(clampViewport({ start: 30, end: 20 }, 100)).toEqual({ start: 30, end: 31 });
    expect(clampViewport({ start: -20, end: 20 }, 100)).toEqual({ start: 0, end: 40 });
    expect(clampViewport({ start: 80, end: 120 }, 100)).toEqual({ start: 60, end: 100 });
    expect(clampViewport({ start: 80, end: 1000 }, 100)).toEqual({ start: 0, end: 100 });
  });

  it("zooms around the requested anchor and clamps at file edges", () => {
    const viewport = { start: 100, end: 500 };
    expect(zoomViewport(viewport, 1000, 2)).toEqual({ start: 200, end: 400 });
    expect(zoomViewport(viewport, 1000, 2, 0)).toEqual({ start: 100, end: 300 });
    expect(zoomViewport(viewport, 1000, 2, 1)).toEqual({ start: 300, end: 500 });
    expect(zoomViewport(viewport, 1000, 2, -10)).toEqual({ start: 100, end: 300 });
    expect(zoomViewport(viewport, 1000, 2, 10)).toEqual({ start: 300, end: 500 });
    expect(zoomViewport(viewport, 1000, 0.001)).toEqual({ start: 0, end: 1000 });
    expect(zoomViewport(viewport, 1000, 1e10)).toEqual({ start: 300, end: 301 });
    expect(zoomViewport({ start: 0, end: 1 }, 1, 10)).toEqual({ start: 0, end: 1 });
    expect(zoomViewport({ start: 0, end: 0 }, 0, 10)).toEqual({ start: 0, end: 0 });
  });

  it("pans without shortening the viewport and retains offsets beyond Int32", () => {
    const offset = 2 ** 32;
    const viewport = { start: offset + 100, end: offset + 500 };
    expect(panViewport(viewport, offset + 1000, 100)).toEqual({
      start: offset + 200,
      end: offset + 600,
    });
    expect(panViewport(viewport, offset + 1000, 1000)).toEqual({
      start: offset + 600,
      end: offset + 1000,
    });
    expect(panViewport({ start: 100, end: 500 }, 1000, -1000)).toEqual({ start: 0, end: 400 });
    expect(panViewport({ start: 100, end: 500 }, 1000, Number.MAX_VALUE)).toEqual({
      start: 600,
      end: 1000,
    });
    expect(frameToX(offset + 300, viewport, 800)).toBe(400);
    expect(xToFrame(400, viewport, 800)).toBe(offset + 300);
  });

  it("maps hit tests at the edges while leaving offscreen draw coordinates offscreen", () => {
    const range = { start: 100, end: 200 };
    expect(frameToX(100, range, 500)).toBe(0);
    expect(frameToX(200, range, 500)).toBe(500);
    expect(frameToX(90, range, 500)).toBe(-50);
    expect(xToFrame(-20, range, 500)).toBe(100);
    expect(xToFrame(600, range, 500)).toBe(200);
    expect(xToFrame(252, range, 500)).toBe(150);
    expect(frameToX(0, { start: 0, end: 0 }, 500)).toBe(0);
    expect(xToFrame(10, { start: 17, end: 17 }, 0)).toBe(17);
  });

  it("preserves short viewports at the largest safe frame positions", () => {
    const total = Number.MAX_SAFE_INTEGER;
    for (const span of [1, 3, 7]) {
      expect(panViewport({ start: 1, end: 1 + span }, total, total)).toEqual({
        start: total - span,
        end: total,
      });
      expect(panViewport({ start: total - span, end: total }, total, -total)).toEqual({
        start: 0,
        end: span,
      });
      expect(panViewport({ start: total - span, end: total }, total, total)).toEqual({
        start: total - span,
        end: total,
      });
    }
  });

  it("keeps viewport operations finite for invalid event values", () => {
    const range = { start: 10, end: 20 };
    for (const factor of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(zoomViewport(range, 100, factor)).toEqual(range);
    }
    expect(panViewport(range, 100, Number.NaN)).toEqual(range);
    expect(clampViewport({ start: Number.NaN, end: Number.POSITIVE_INFINITY }, 100)).toEqual({
      start: 0,
      end: 100,
    });
    expect(clampViewport(range, Number.NaN)).toEqual({ start: 0, end: 0 });
    expect(frameToX(Number.NaN, range, 100)).toBe(0);
    expect(frameToX(10, { start: Number.NaN, end: 10 }, 100)).toBe(0);
    expect(xToFrame(Number.NaN, range, 100)).toBe(10);
    expect(xToFrame(10, { start: Number.NaN, end: 10 }, 100)).toBe(0);
  });
});

describe("waveform rulers", () => {
  it("formats samples, seconds and clock time without losing long-file offsets", () => {
    expect(formatTime(2 ** 32 + 123, 48000, "samples")).toBe("4,294,967,419");
    expect(formatTime(72000, 48000, "seconds")).toBe("1.5 s");
    expect(formatTime(48000 * (3600 + 120 + 3) + 24000, 48000, "hms")).toBe("1:02:03.500");
    expect(formatTime(59.9996 * 48000, 48000, "hms")).toBe("0:01:00.000");
    expect(formatTime(-1, 48000, "samples")).toBe("0");
    expect(formatTime(Number.NaN, 48000, "hms")).toBe("0:00:00.000");
  });

  it("generates ordered visible nice ticks in all units", () => {
    for (const format of ["samples", "seconds", "hms"] as const) {
      const ticks = generateTimeTicks({ start: 48000, end: 480000 }, 900, 48000, format);
      expect(ticks.length).toBeGreaterThan(1);
      for (let index = 0; index < ticks.length; index++) {
        expect(ticks[index].frame).toBeGreaterThanOrEqual(48000);
        expect(ticks[index].frame).toBeLessThanOrEqual(480000);
        expect(ticks[index].x).toBeGreaterThanOrEqual(0);
        expect(ticks[index].x).toBeLessThanOrEqual(900);
        expect(ticks[index].label).toBe(formatTime(ticks[index].frame, 48000, format));
        if (index > 0) expect(ticks[index].frame).toBeGreaterThan(ticks[index - 1].frame);
      }
    }
    expect(generateTimeTicks({ start: 0, end: 0 }, 900, 48000)).toEqual([]);
    expect(generateTimeTicks({ start: 0, end: 100 }, 0, 48000)).toEqual([]);
    expect(
      generateTimeTicks({ start: 2 ** 32, end: 2 ** 32 + 1 }, 900, 48000, "samples").map(
        (tick) => tick.frame,
      ),
    ).toEqual([2 ** 32, 2 ** 32 + 1]);
    expect(generateTimeTicks({ start: Number.NaN, end: 1 }, 900, 48000)).toEqual([]);
    expect(generateTimeTicks({ start: 0, end: 1e9 }, 1e10, 48000).length).toBeLessThanOrEqual(201);
  });

  it("places linear and dB labels on the same normalized amplitude axis", () => {
    expect(amplitudeToY(1, 200)).toBe(0);
    expect(amplitudeToY(0, 200)).toBe(100);
    expect(amplitudeToY(-0, 200)).toBe(100);
    expect(amplitudeToY(-1, 200)).toBe(200);
    expect(amplitudeToY(2, 200)).toBe(0);
    expect(amplitudeToY(-Infinity, 200)).toBe(200);
    expect(amplitudeToY(Number.NaN, 200)).toBe(100);
    expect(formatAmplitude(-0, "linear")).toBe("0");
    expect(formatAmplitude(0, "db")).toBe("−∞");
    expect(formatAmplitude(1, "db")).toBe("0");
    expect(formatAmplitude(-0.5, "db")).toBe("-6");
    const ticks = generateAmplitudeTicks(200, "db");
    expect(ticks.map((tick) => tick.label)).toEqual(["0", "-6", "-12", "−∞", "-12", "-6", "0"]);
    expect(ticks[1].y).toBeCloseTo(amplitudeToY(10 ** (-6 / 20), 200));
    expect(generateAmplitudeTicks(80, "linear").map((tick) => tick.label)).toEqual([
      "1",
      "0",
      "-1",
    ]);
    expect(generateAmplitudeTicks(0, "db")).toEqual([]);
  });
});
