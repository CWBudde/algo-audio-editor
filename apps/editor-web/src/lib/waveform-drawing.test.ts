import { describe, expect, it, vi } from "vitest";
import type { PeakViews } from "@/kernel/peak-data";
import { drawSampleWaveform, drawWaveform, resizeCanvas } from "./waveform-drawing";

function recordingCanvas() {
  const ctx = {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    setTransform: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
  };
  const canvas = {
    width: 0,
    height: 0,
    style: { width: "", height: "" },
    getContext: vi.fn(() => ctx),
  };
  return { ctx, canvas };
}

describe("waveform canvas drawing", () => {
  it("sizes the bitmap for DPR and draws in CSS pixels", () => {
    const { ctx, canvas } = recordingCanvas();
    expect(resizeCanvas(canvas as unknown as HTMLCanvasElement, 301, 125, 2)).toBe(ctx);
    expect(canvas.width).toBe(602);
    expect(canvas.height).toBe(250);
    expect(canvas.style).toEqual({ width: "301px", height: "125px" });
    expect(ctx.setTransform).toHaveBeenLastCalledWith(2, 0, 0, 2, 0, 0);
    resizeCanvas(canvas as unknown as HTMLCanvasElement, 201.5, 75.5, 1.5);
    expect(canvas.width).toBe(302);
    expect(canvas.height).toBe(113);
    expect(ctx.setTransform).toHaveBeenLastCalledWith(1.5, 0, 0, 1.5, 0, 0);
    resizeCanvas(canvas as unknown as HTMLCanvasElement, -1, Number.NaN, Number.NaN);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(ctx.setTransform).toHaveBeenLastCalledWith(1, 0, 0, 1, 0, 0);
  });

  it("clips intersecting cached buckets using their true frame starts and short tails", () => {
    const { ctx } = recordingCanvas();
    const peaks: PeakViews = {
      peaks: new Float32Array([-1, 1, 0.5, -0.5, 0.75, 0.25, -0.25, 0.25, 0.125, -1, 1, 1]),
      startFrames: new Float64Array([0, 100, 200, 250]),
      frameCounts: new Uint32Array([100, 100, 50, 100]),
    };
    drawWaveform(
      ctx as unknown as CanvasRenderingContext2D,
      peaks,
      { start: 150, end: 225 },
      300,
      200,
    );
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 300, 200);
    expect(ctx.rect).toHaveBeenCalledWith(0, 0, 300, 200);
    expect(ctx.clip).toHaveBeenCalledTimes(1);
    expect(ctx.fillRect.mock.calls).toEqual([
      [0, 25, 200, 125],
      [200, 75, 100, 50],
      [0, 75, 200, 50],
      [200, 87.5, 100, 25],
    ]);
    expect(ctx.moveTo).toHaveBeenCalledWith(100, 75);
    expect(ctx.lineTo).toHaveBeenCalledWith(250, 87.5);
    expect(ctx.restore).toHaveBeenCalledTimes(1);
  });

  it("supports overview colors and suppresses RMS when requested", () => {
    const { ctx } = recordingCanvas();
    const peaks: PeakViews = {
      peaks: new Float32Array([-1, 1, 0.5]),
      startFrames: new Float64Array([2 ** 32]),
      frameCounts: new Uint32Array([1]),
    };
    drawWaveform(
      ctx as unknown as CanvasRenderingContext2D,
      peaks,
      { start: 2 ** 32, end: 2 ** 32 + 1 },
      10,
      20,
      { background: "black", peakColor: "teal", showRMS: false },
    );
    expect(ctx.fillRect.mock.calls).toEqual([
      [0, 0, 10, 20],
      [0, 0, 10, 20],
    ]);
    expect(ctx.fillStyle).toBe("teal");
    expect(ctx.stroke).not.toHaveBeenCalled();
  });

  it("clears empty views and bounds nonfinite summaries without changing the source", () => {
    const { ctx } = recordingCanvas();
    drawWaveform(ctx as unknown as CanvasRenderingContext2D, null, { start: 0, end: 0 }, 100, 50);
    expect(ctx.clearRect).toHaveBeenCalledOnce();
    expect(ctx.fillRect).not.toHaveBeenCalled();
    const peaks: PeakViews = {
      peaks: new Float32Array([-Infinity, Infinity, Infinity, Number.NaN, Number.NaN, Number.NaN]),
      startFrames: new Float64Array([0, 10]),
      frameCounts: new Uint32Array([10, 10]),
    };
    const source = new Uint32Array(peaks.peaks.buffer).slice();
    drawWaveform(ctx as unknown as CanvasRenderingContext2D, peaks, { start: 0, end: 20 }, 100, 50);
    for (const args of ctx.fillRect.mock.calls) {
      expect(args.every((value) => Number.isFinite(value))).toBe(true);
    }
    expect(ctx.fillRect.mock.calls).toEqual([
      [0, 0, 50, 50],
      [0, 0, 50, 50],
    ]);
    expect(ctx.lineTo).not.toHaveBeenCalled();
    expect(new Uint32Array(peaks.peaks.buffer)).toEqual(source);
  });

  it("omits NaN extrema and RMS independently without drawing through missing RMS", () => {
    const { ctx } = recordingCanvas();
    const peaks: PeakViews = {
      peaks: new Float32Array([
        -1,
        1,
        0.5,
        Number.NaN,
        1,
        Number.NaN,
        -1,
        Number.NaN,
        0.25,
        -1,
        1,
        0.5,
      ]),
      startFrames: new Float64Array([0, 10, 20, 30]),
      frameCounts: new Uint32Array([10, 10, 10, 10]),
    };
    drawWaveform(
      ctx as unknown as CanvasRenderingContext2D,
      peaks,
      { start: 0, end: 40 },
      100,
      100,
    );
    expect(ctx.fillRect.mock.calls).toEqual([
      [0, 0, 25, 100],
      [75, 0, 25, 100],
      [0, 25, 25, 50],
      [50, 37.5, 25, 25],
      [75, 25, 25, 50],
    ]);
    expect(ctx.moveTo.mock.calls).toEqual([
      [12.5, 25],
      [62.5, 37.5],
    ]);
    expect(ctx.lineTo).toHaveBeenCalledWith(87.5, 25);
  });
});

function samples(start: number, values: number[]): PeakViews {
  return {
    peaks: new Float32Array(values.flatMap((value) => [value, value, 42])),
    startFrames: Float64Array.from(values, (_, index) => start + index),
    frameCounts: Uint32Array.from(values, () => 1),
  };
}

describe("sample waveform geometry", () => {
  it("draws signed exact sample points and straight connections by default, without RMS", () => {
    const { ctx } = recordingCanvas();
    drawSampleWaveform(
      ctx as unknown as CanvasRenderingContext2D,
      [samples(0, [-1, 0, 1])],
      { start: 0, end: 3 },
      300,
      100,
    );
    expect(ctx.moveTo.mock.calls[0]).toEqual([0, 100]);
    expect(ctx.lineTo.mock.calls).toEqual([
      [100, 50],
      [200, 0],
    ]);
    expect(ctx.arc.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      [0, 100, 2.5],
      [100, 50, 2.5],
      [200, 0, 2.5],
    ]);
    expect(ctx.fillRect).not.toHaveBeenCalled();
    expect(ctx.stroke).toHaveBeenCalledOnce();
    expect(ctx.fill).toHaveBeenCalledOnce();
    expect(ctx.clip).toHaveBeenCalledOnce();
  });

  it("holds each step until the next frame boundary, including the final EOF interval", () => {
    const { ctx } = recordingCanvas();
    drawSampleWaveform(
      ctx as unknown as CanvasRenderingContext2D,
      [samples(0, [-1, 0, 1])],
      { start: 0, end: 3 },
      300,
      100,
      "steps",
    );
    expect(ctx.lineTo.mock.calls).toEqual([
      [100, 100],
      [100, 50],
      [200, 50],
      [200, 0],
      [300, 0],
    ]);
    expect(ctx.arc).toHaveBeenCalledTimes(3);
    // Unlike steps, linear never extrapolates beyond its final actual point.
    const linear = recordingCanvas();
    drawSampleWaveform(
      linear.ctx as unknown as CanvasRenderingContext2D,
      [samples(0, [0.25])],
      { start: 0, end: 1 },
      100,
      100,
    );
    expect(linear.ctx.lineTo).not.toHaveBeenCalled();
    expect(linear.ctx.arc.mock.calls[0].slice(0, 2)).toEqual([0, 37.5]);
  });

  it("joins page seams and offscreen neighbors but draws only visible dots", () => {
    const { ctx } = recordingCanvas();
    const pages = [samples(9, [-1, 0.25]), samples(11, [-0.5, 0.75, 1])];
    drawSampleWaveform(
      ctx as unknown as CanvasRenderingContext2D,
      pages,
      { start: 10, end: 13 },
      300,
      100,
    );
    expect(ctx.moveTo.mock.calls[0]).toEqual([-100, 100]);
    expect(ctx.lineTo.mock.calls).toEqual([
      [0, 37.5],
      [100, 75],
      [200, 12.5],
      [300, 0],
    ]);
    expect(ctx.arc.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      [0, 37.5],
      [100, 75],
      [200, 12.5],
    ]);
    expect(ctx.rect).toHaveBeenCalledWith(0, 0, 300, 100);
  });

  it("breaks NaN/missing/aggregate gaps and clips infinities without invalid canvas coordinates", () => {
    const { ctx } = recordingCanvas();
    const page = samples(0, [-Infinity, NaN, Infinity, 0.25]);
    const sourceBits = new Uint32Array(page.peaks.buffer).slice();
    drawSampleWaveform(
      ctx as unknown as CanvasRenderingContext2D,
      [page],
      { start: 0, end: 4 },
      400,
      100,
    );
    expect(ctx.lineTo.mock.calls).toEqual([[300, 37.5]]);
    expect(ctx.arc.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      [0, 100],
      [200, 0],
      [300, 37.5],
    ]);
    for (const call of [...ctx.moveTo.mock.calls, ...ctx.lineTo.mock.calls, ...ctx.arc.mock.calls])
      expect(call.every(Number.isFinite)).toBe(true);
    expect(new Uint32Array(page.peaks.buffer)).toEqual(sourceBits);
    const other = recordingCanvas();
    const aggregate = samples(1, [0.5]);
    aggregate.frameCounts[0] = 2;
    drawSampleWaveform(
      other.ctx as unknown as CanvasRenderingContext2D,
      [samples(0, [0]), aggregate, samples(3, [0.25])],
      { start: 0, end: 4 },
      400,
      100,
    );
    expect(other.ctx.lineTo).not.toHaveBeenCalled();
    expect(other.ctx.arc).toHaveBeenCalledTimes(2);
  });

  it("keeps coordinates in CSS pixels at DPR2 and safely maps the largest frame offsets", () => {
    const { ctx, canvas } = recordingCanvas();
    resizeCanvas(canvas as unknown as HTMLCanvasElement, 200, 100, 2);
    const end = Number.MAX_SAFE_INTEGER;
    drawSampleWaveform(
      ctx as unknown as CanvasRenderingContext2D,
      [samples(end - 2, [-0.5, 0.5])],
      { start: end - 2, end },
      200,
      100,
      "steps",
    );
    expect(ctx.lineTo.mock.calls).toEqual([
      [100, 75],
      [100, 25],
      [200, 25],
    ]);
    expect(ctx.arc.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      [0, 75],
      [100, 25],
    ]);
    expect(canvas.width).toBe(400);
  });

  it("redraws cached pages in either mode with explicit palette colors and no sample mutation", () => {
    const { ctx } = recordingCanvas();
    const page = samples(0, [-0.25, 0.5]);
    const original = new Uint32Array(page.peaks.buffer).slice();
    const colors = {
      background: "#101010",
      peakColor: "#abcdef",
      sampleColor: "#123456",
      rmsColor: "#ff0000",
    };
    for (const mode of ["linear", "steps"] as const)
      drawSampleWaveform(
        ctx as unknown as CanvasRenderingContext2D,
        [page],
        { start: 0, end: 2 },
        100,
        50,
        mode,
        colors,
      );
    expect(ctx.strokeStyle).toBe(colors.peakColor);
    expect(ctx.fillStyle).toBe(colors.sampleColor);
    expect(ctx.fillRect.mock.calls).toEqual([
      [0, 0, 100, 50],
      [0, 0, 100, 50],
    ]);
    expect(new Uint32Array(page.peaks.buffer)).toEqual(original);
  });

  it("clears missing/empty/invalid ranges without fabricating sample geometry", () => {
    const { ctx } = recordingCanvas();
    for (const range of [
      { start: 0, end: 0 },
      { start: NaN, end: 1 },
      { start: 0, end: Infinity },
    ])
      drawSampleWaveform(
        ctx as unknown as CanvasRenderingContext2D,
        [samples(0, [0])],
        range,
        100,
        50,
      );
    drawSampleWaveform(
      ctx as unknown as CanvasRenderingContext2D,
      undefined,
      { start: 0, end: 1 },
      100,
      50,
    );
    expect(ctx.clearRect).toHaveBeenCalledTimes(4);
    expect(ctx.arc).not.toHaveBeenCalled();
    expect(ctx.stroke).not.toHaveBeenCalled();
  });
});
