import type { AnalysisJobResult } from "@aae/protocol";
import { expect, it, vi } from "vitest";
import { runAnalysisJob, validAnalysisProgress } from "./analysis-runner";

const params = { documentId: "doc", jobId: "analysis-1" };
const analysisJob: AnalysisJobResult = {
  ...params,
  kind: "statistics",
  state: "running",
  start: 0,
  end: 100,
  channelMask: 3,
  processedFrames: 0,
  totalFrames: 100,
  sampleRate: 48000,
  dataBytes: 0,
  channels: [0, 1],
  integratedLUFS: null,
};
it("yields between bounded steps and owns final binary transfer without a processing commit", async () => {
  const data = new ArrayBuffer(4 * 8 * 4);
  const jobs = [
    {
      ...analysisJob,
      kind: "spectrogram",
      width: 4,
      height: 8,
      completedColumns: 1,
      dataBytes: data.byteLength,
      data,
    },
    {
      ...analysisJob,
      kind: "spectrogram",
      state: "ready",
      processedFrames: 100,
      width: 4,
      height: 8,
      completedColumns: 4,
      dataBytes: 128,
      data: new ArrayBuffer(128),
    },
  ];
  const yielded = vi.fn().mockResolvedValue(undefined),
    progress = vi.fn((job, transfer) => {
      structuredClone(job, { transfer });
    });
  const result = await runAnalysisJob(params, {
    step: () => {
      const result = jobs.shift();
      return { result, transfer: result?.data ? [result.data] : undefined };
    },
    progress,
    yieldTask: yielded,
  });
  expect(progress).toHaveBeenCalledOnce();
  expect(yielded).toHaveBeenCalledOnce();
  expect(data.byteLength).toBe(0);
  expect(result.transfer).toEqual([(result.result as AnalysisJobResult).data]);
});
it.each([
  { documentId: "other" },
  { processedFrames: -1 },
  { channels: [8] },
  { sampleRate: 1 },
  { dataBytes: 8 },
  { state: "unexpected" },
  { kind: "unexpected" },
])("rejects malformed or stale progress %j", (change) => {
  expect(validAnalysisProgress({ ...analysisJob, ...change }, params)).toBe(false);
});
it("accepts cooperative work with unchanged processed frames but rejects backward progress", () => {
  expect(validAnalysisProgress(analysisJob, params, analysisJob)).toBe(true);
  expect(validAnalysisProgress(analysisJob, params, { ...analysisJob, processedFrames: 1 })).toBe(
    false,
  );
});

it("limits progressive image transfers to 20 Hz while always returning the final tile", async () => {
  const now = vi
    .spyOn(performance, "now")
    .mockReturnValueOnce(0)
    .mockReturnValueOnce(10)
    .mockReturnValueOnce(51);
  const frames = [1, 2, 3, 4].map((column) => ({
    ...analysisJob,
    kind: "spectrogram" as const,
    state: column === 4 ? ("ready" as const) : ("running" as const),
    width: 4,
    height: 8,
    completedColumns: column,
    dataBytes: 128,
    data: new ArrayBuffer(128),
  }));
  const progress = vi.fn();
  const final = frames[3];
  await runAnalysisJob(params, {
    step: () => ({ result: frames.shift() }),
    progress,
    yieldTask: async () => {},
  });
  expect(progress.mock.calls.map((call) => call[0].completedColumns)).toEqual([1, 3]);
  expect(final.state).toBe("ready");
  now.mockRestore();
});
