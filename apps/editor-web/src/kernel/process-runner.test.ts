import type { KernelBridge, ProcessJobResult } from "@aae/protocol";
import { describe, expect, it, vi } from "vitest";
import processWireGolden from "../../../../packages/kernel/internal/protocol/testdata/process-jobs.json?raw";
import { runProcessJob, stepProcessBatch, validProcessProgress } from "./process-runner";

const params = { documentId: "doc-1", jobId: "job-1" };
const progress: ProcessJobResult = {
  candidate: { sampleRate: 48000, channels: 3, frames: 100, start: 10, end: 30, channelMask: 5 },
  ...params,
  start: 10,
  end: 30,
  channelMask: 5,
  state: "running",
  operation: "gain",
  phase: "processing",
  phaseIndex: 0,
  phaseCount: 1,
  gainResolved: true,
  inputPeak: 0,
  inputLufs: null,
  predictedLufs: null,
  outputLufs: null,
  planningSteps: 0,
  gainDb: 6,
  processedFrames: 8,
  totalFrames: 20,
  peak: 0.5,
  nonFinite: false,
};

it.each(["gain", "normalize-peak", "normalize-loudness"] as const)(
  "rejects omitted candidate geometry for ABI 11 %s jobs",
  (operation) => {
    const p =
      operation === "gain"
        ? progress
        : operation === "normalize-peak"
          ? peakAnalysis
          : loudnessAnalysis;
    expect(validProcessProgress({ ...p, candidate: undefined }, params)).toBe(false);
    expect(validProcessProgress({ ...p, candidate: null }, params)).toBe(false);
  },
);

const peakAnalysis: ProcessJobResult = {
  ...progress,
  operation: "normalize-peak",
  target: -1,
  phase: "analyzing",
  phaseIndex: 0,
  phaseCount: 2,
  gainResolved: false,
  gainDb: 0,
  peak: 0,
  inputPeak: 0.25,
};

const loudnessAnalysis: ProcessJobResult = {
  ...peakAnalysis,
  operation: "normalize-loudness",
  target: -23,
  phaseCount: 3,
  processedFrames: 20,
};

it.each([
  "fade-in",
  "fade-out",
  "crossfade",
  "reverse",
  "invert",
  "mono-to-stereo",
  "stereo-to-mono",
  "resample",
  "generate",
  "extract-channel",
] as const)("validates %s progress with independent source and output dimensions", (operation) => {
  const p: ProcessJobResult = {
    ...progress,
    operation,
    gainDb: 0,
    start: 10,
    end: 10,
    totalFrames: 100,
    candidate: { sampleRate: 44100, channels: 1, frames: 100, start: 0, end: 0, channelMask: 1 },
  };
  expect(validProcessProgress(p, params)).toBe(true);
  expect(validProcessProgress({ ...p, candidate: undefined }, params)).toBe(false);
  expect(validProcessProgress({ ...p, candidate: { ...p.candidate, channels: 0 } }, params)).toBe(
    false,
  );
  expect(validProcessProgress({ ...p, candidate: { ...p.candidate, end: 101 } }, params)).toBe(
    false,
  );
  expect(validProcessProgress({ ...p, target: -1 }, params)).toBe(false);
  expect(validProcessProgress({ ...p, processedFrames: 101 }, params)).toBe(false);
  const changed = { ...p, candidate: { ...p.candidate, sampleRate: 48000 } };
  expect(validProcessProgress(changed, params, p)).toBe(false);
});

it("retains bounded analysis and processing phases for complete-range DC removal", () => {
  const p: ProcessJobResult = {
    ...progress,
    operation: "remove-dc",
    gainDb: 0,
    phase: "analyzing",
    phaseCount: 2,
    candidate: { sampleRate: 48000, channels: 3, frames: 100, start: 10, end: 30, channelMask: 5 },
  };
  expect(validProcessProgress(p, params)).toBe(true);
  const processing: ProcessJobResult = {
    ...p,
    phase: "processing",
    phaseIndex: 1,
    processedFrames: 0,
  };
  expect(validProcessProgress(processing, params, p)).toBe(true);
  expect(
    validProcessProgress(
      { ...processing, state: "ready", processedFrames: 20 },
      params,
      processing,
    ),
  ).toBe(true);
  expect(validProcessProgress({ ...p, phaseCount: 1 }, params)).toBe(false);
});

describe("processing runner", () => {
  it("uses the bounded Go batch bridge and yields between all visible phases", async () => {
    const resolved: ProcessJobResult = {
      ...loudnessAnalysis,
      phase: "processing",
      phaseIndex: 1,
      processedFrames: 0,
      gainResolved: true,
      gainDb: -5,
      inputLufs: -18,
      predictedLufs: -23,
      planningSteps: 1,
    };
    const values: ProcessJobResult[] = [
      loudnessAnalysis,
      resolved,
      { ...resolved, processedFrames: 20, peak: 0.1405853 },
      { ...resolved, phase: "verifying", phaseIndex: 2, peak: 0.1405853 },
      {
        ...resolved,
        state: "ready",
        phase: "verifying",
        phaseIndex: 2,
        processedFrames: 20,
        peak: 0.1405853,
        planningSteps: 2,
        outputLufs: -23.0000001,
      },
    ];
    const calls = vi.fn((method: string, payload?: string, data?: Uint8Array) => {
      expect(method).toBe("process.stepBatch");
      expect(JSON.parse(payload ?? "null")).toEqual(params);
      expect(data).toBeUndefined();
      const result = values.shift();
      if (!result) throw new Error("unexpected extra batch");
      return JSON.stringify({ ok: true, result });
    });
    const bridge: KernelBridge = {
      call: calls,
      takeData: vi.fn(() => new Uint8Array()),
      render: vi.fn(() => 0),
    };
    const listener = vi.fn();
    const yieldTask = vi.fn(async () => {});
    await expect(
      runProcessJob(params, {
        step: (target) => stepProcessBatch(bridge, target),
        progress: listener,
        yieldTask,
      }),
    ).resolves.toMatchObject({ state: "ready", outputLufs: -23.0000001 });
    expect(calls).toHaveBeenCalledTimes(5);
    expect(yieldTask).toHaveBeenCalledTimes(4);
    expect(listener.mock.calls.map(([value]) => value.phase)).toEqual([
      "analyzing",
      "processing",
      "processing",
      "verifying",
      "verifying",
    ]);
    expect(bridge.takeData).not.toHaveBeenCalled();
    expect(bridge.render).not.toHaveBeenCalled();
  });

  it("propagates a rejected batch without inventing progress or a commit", async () => {
    const bridge: KernelBridge = {
      call: vi.fn(() => JSON.stringify({ ok: false, error: "process.stepBatch: source changed" })),
      takeData: vi.fn(() => new Uint8Array()),
      render: vi.fn(() => 0),
    };
    const listener = vi.fn();
    const yieldTask = vi.fn(async () => {});
    await expect(
      runProcessJob(params, {
        step: (target) => stepProcessBatch(bridge, target),
        progress: listener,
        yieldTask,
      }),
    ).rejects.toThrow("source changed");
    expect(listener).not.toHaveBeenCalled();
    expect(yieldTask).not.toHaveBeenCalled();
    expect(bridge.call).toHaveBeenCalledExactlyOnceWith(
      "process.stepBatch",
      JSON.stringify(params),
      undefined,
    );
  });

  it("accepts the raw JSON wire golden also checked against Go serialization", () => {
    const values: unknown[] = JSON.parse(processWireGolden);
    expect(values).toHaveLength(3);
    for (const value of values) expect(validProcessProgress(value, params)).toBe(true);
  });
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

  it("allows linked peak planning to resolve gain and reset only the next phase's frame count", () => {
    const processing: ProcessJobResult = {
      ...peakAnalysis,
      phase: "processing",
      phaseIndex: 1,
      processedFrames: 0,
      gainResolved: true,
      gainDb: 11.041199826559248,
    };
    expect(validProcessProgress(peakAnalysis, params)).toBe(true);
    expect(validProcessProgress(processing, params, peakAnalysis)).toBe(true);
    expect(
      validProcessProgress(
        { ...processing, processedFrames: 20, peak: 0.8912509, state: "ready" },
        params,
        processing,
      ),
    ).toBe(true);
    expect(validProcessProgress({ ...processing, inputPeak: 0.5 }, params, processing)).toBe(false);
    expect(validProcessProgress({ ...processing, gainDb: 12 }, params, processing)).toBe(false);
    expect(validProcessProgress({ ...processing, target: -2 }, params, processing)).toBe(false);
    expect(
      validProcessProgress({ ...peakAnalysis, processedFrames: 0 }, params, peakAnalysis),
    ).toBe(false);
  });

  it("yields throughout real planning and all three loudness phases without inventing an output metric", async () => {
    const planning = { ...loudnessAnalysis, planningSteps: 1 };
    const processing: ProcessJobResult = {
      ...planning,
      phase: "processing",
      phaseIndex: 1,
      processedFrames: 0,
      gainResolved: true,
      gainDb: -5,
      inputLufs: -18,
      predictedLufs: -23,
    };
    const verifying: ProcessJobResult = {
      ...processing,
      phase: "verifying",
      phaseIndex: 2,
      processedFrames: 0,
      peak: 0.1405853,
    };
    const ready: ProcessJobResult = {
      ...verifying,
      processedFrames: 20,
      planningSteps: 2,
      outputLufs: -23.0000001,
      state: "ready",
    };
    const values = [loudnessAnalysis, planning, processing, verifying, ready];
    const yieldTask = vi.fn(async () => {});
    const listener = vi.fn();
    await expect(
      runProcessJob(params, {
        step: () => {
          const next = values.shift();
          if (!next) throw new Error("extra step");
          return next;
        },
        progress: listener,
        yieldTask,
      }),
    ).resolves.toEqual(ready);
    expect(yieldTask).toHaveBeenCalledTimes(4);
    expect(listener.mock.calls.map(([value]) => value.phase)).toEqual([
      "analyzing",
      "analyzing",
      "processing",
      "verifying",
      "verifying",
    ]);
    expect(validProcessProgress({ ...planning, planningSteps: 0 }, params, planning)).toBe(false);
    expect(validProcessProgress(verifying, params, planning)).toBe(false);
    expect(validProcessProgress({ ...processing, outputLufs: -23 }, params)).toBe(false);
    expect(validProcessProgress({ ...ready, outputLufs: -22.9 }, params)).toBe(false);
    expect(
      validProcessProgress({ ...processing, state: "ready", processedFrames: 20 }, params),
    ).toBe(false);
    expect(validProcessProgress({ ...ready, inputLufs: null }, params, processing)).toBe(false);
  });

  it("accepts an explicit silent no-op phase skip but not fabricated silence or a generic skip", () => {
    const silent: ProcessJobResult = {
      ...loudnessAnalysis,
      phase: "verifying",
      phaseIndex: 2,
      gainResolved: true,
      state: "ready",
      inputPeak: 0,
      unchangedReason: "silent",
    };
    const start = { ...loudnessAnalysis, inputPeak: 0, processedFrames: 0 };
    expect(validProcessProgress(silent, params, start)).toBe(true);
    expect(validProcessProgress({ ...silent, inputPeak: 0.1 }, params, start)).toBe(false);
    expect(validProcessProgress({ ...silent, state: "running" }, params, start)).toBe(false);
    expect(
      validProcessProgress(
        { ...silent, unchangedReason: undefined, predictedLufs: -23 },
        params,
        start,
      ),
    ).toBe(false);
    expect(validProcessProgress({ ...start, state: "cancelled" }, params, start)).toBe(true);
  });

  it("rejects out-of-range phase indices even when the phase field is absent", () => {
    // Accessing an array beyond its end also returns undefined. Missing phase
    // metadata must not compare equal to that sentinel and become a heartbeat.
    expect(validProcessProgress({ ...progress, phaseIndex: 1, phase: undefined }, params)).toBe(
      false,
    );
    expect(
      validProcessProgress(
        {
          ...loudnessAnalysis,
          phaseIndex: 3,
          phase: undefined,
          gainResolved: true,
          gainDb: -5,
          predictedLufs: -23,
        },
        params,
      ),
    ).toBe(false);
  });

  it.each([progress, peakAnalysis])("rejects fabricated planning work for $operation", (value) => {
    expect(validProcessProgress({ ...value, planningSteps: 1 }, params)).toBe(false);
  });

  it.each([
    { phase: "processing" },
    { phaseIndex: -1 },
    { phaseIndex: 1.5 },
    { phaseCount: 2 },
    { gainResolved: false, gainDb: 1 },
    { inputLufs: undefined },
    { predictedLufs: Number.NaN },
    { outputLufs: Number.POSITIVE_INFINITY },
    { inputPeak: -1 },
    { planningSteps: -1 },
    { planningSteps: Number.MAX_SAFE_INTEGER + 1 },
    { target: -70 },
    { target: 1 },
    { gainResolved: true, predictedLufs: null },
    { gainResolved: true, predictedLufs: -22.9 },
  ])("rejects malformed phase-aware loudness progress %j", (changes) => {
    expect(validProcessProgress({ ...loudnessAnalysis, ...changes }, params)).toBe(false);
  });
});
