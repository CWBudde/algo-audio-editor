import type { ProcessJobResult } from "@aae/protocol";
import { describe, expect, it, vi } from "vitest";
import { runProcessJob, validProcessProgress } from "./process-runner";

const params = { documentId: "doc-1", jobId: "job-1" };
const progress: ProcessJobResult = {
  ...params,
  start: 10,
  end: 30,
  channelMask: 5,
  state: "running",
  operation: "gain",
  gainDb: 6,
  processedFrames: 8,
  totalFrames: 20,
  peak: 0.5,
  nonFinite: false,
};

describe("processing runner", () => {
  it("yields a task between every bounded Go chunk, reports progress, and never commits", async () => {
    const order: string[] = [];
    const values = [
      progress,
      { ...progress, processedFrames: 16 },
      { ...progress, processedFrames: 20, state: "ready" as const },
    ];
    const step = vi.fn(() => {
      order.push("step");
      const next = values.shift();
      if (!next) throw new Error("extra step");
      return next;
    });
    const listener = vi.fn((value: ProcessJobResult) => order.push(value.state));
    const result = await runProcessJob(params, {
      step,
      progress: listener,
      yieldTask: async () => {
        order.push("yield");
      },
    });
    expect(order).toEqual([
      "step",
      "running",
      "yield",
      "step",
      "running",
      "yield",
      "step",
      "ready",
    ]);
    expect(result.state).toBe("ready");
    expect(step.mock.calls).toEqual([[params], [params], [params]]);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("lets cancellation run while a queued chunk waits and resolves the cancelled tombstone", async () => {
    let release!: () => void;
    let cancelled = false;
    const step = vi.fn(() => (cancelled ? { ...progress, state: "cancelled" as const } : progress));
    const listener = vi.fn();
    const pending = runProcessJob(params, {
      step,
      progress: listener,
      yieldTask: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    expect(step).toHaveBeenCalledOnce();
    cancelled = true;
    release();
    await expect(pending).resolves.toMatchObject({ state: "cancelled", processedFrames: 8 });
    expect(step).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls.map(([value]) => value.state)).toEqual(["running", "cancelled"]);
  });

  it.each(["ready", "cancelled"] as const)(
    "does not schedule another chunk for an already-%s job",
    async (state) => {
      const value = { ...progress, state, processedFrames: state === "ready" ? 20 : 8 };
      const yieldTask = vi.fn();
      await expect(
        runProcessJob(params, { step: () => value, progress: vi.fn(), yieldTask }),
      ).resolves.toBe(value);
      expect(yieldTask).not.toHaveBeenCalled();
    },
  );

  it("propagates Go and scheduler failures without inventing success", async () => {
    await expect(
      runProcessJob(params, {
        step: () => {
          throw new Error("Go rejected step");
        },
        progress: vi.fn(),
        yieldTask: async () => {},
      }),
    ).rejects.toThrow("Go rejected step");
    await expect(
      runProcessJob(params, {
        step: () => progress,
        progress: vi.fn(),
        yieldTask: async () => {
          throw new Error("scheduler failed");
        },
      }),
    ).rejects.toThrow("scheduler failed");
  });

  it.each([
    { documentId: "old" },
    { jobId: "old" },
    { state: "committed" },
    { operation: "mix" },
    { processedFrames: -1 },
    { processedFrames: 21 },
    { processedFrames: 1.5 },
    { totalFrames: Number.MAX_SAFE_INTEGER + 1 },
    { start: -1 },
    { end: 9 },
    { channelMask: 0 },
    { channelMask: 256 },
    { channelMask: 1.5 },
    { gainDb: Number.NaN },
    { peak: Number.POSITIVE_INFINITY },
    { peak: -1 },
    { nonFinite: "yes" },
    { state: "ready", processedFrames: 19 },
  ])("rejects malformed progress %j", async (changes) => {
    const value = { ...progress, ...changes } as ProcessJobResult;
    expect(validProcessProgress(value, params)).toBe(false);
    await expect(
      runProcessJob(params, { step: () => value, progress: vi.fn(), yieldTask: async () => {} }),
    ).rejects.toThrow("invalid progress");
  });

  it.each([
    { processedFrames: 7 },
    { totalFrames: 21 },
    { start: 9 },
    { end: 31 },
    { channelMask: 1 },
    { gainDb: 5 },
    { peak: 0.4 },
  ])("rejects regression or changed job metadata %j", (changes) => {
    expect(validProcessProgress({ ...progress, ...changes }, params, progress)).toBe(false);
  });

  it("requires finite telemetry even when input samples are nonfinite and preserves that flag", () => {
    const invalidSamples = { ...progress, nonFinite: true, peak: 0 };
    expect(validProcessProgress(invalidSamples, params)).toBe(true);
    expect(
      validProcessProgress({ ...invalidSamples, nonFinite: false }, params, invalidSamples),
    ).toBe(false);
  });
});
