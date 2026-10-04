import type { AnalysisStartParams } from "@aae/protocol";
import { expect, it, vi } from "vitest";
import { analyse, releaseAnalysis } from "./analysis-queue";
import type { KernelClient } from "./client";

const params: AnalysisStartParams = {
  documentId: "doc",
  start: 0,
  end: 100,
  channelMask: 1,
  kind: "statistics",
};
function fixture() {
  let next = 0;
  const call = vi.fn(
    async (method: string, options?: unknown): Promise<unknown> =>
      method === "analysis.start"
        ? {
            ...params,
            ...(options as object),
            jobId: `job-${++next}`,
            state: "ready",
            dataBytes: 0,
          }
        : {},
  );
  return { call, client: { call } as unknown as KernelClient };
}
it("retains ready clipping ownership until commit or cancellation releases the slot", async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  const clip = await analyse(f.client, { ...params, kind: "clipping" }, signal);
  const later = analyse(f.client, params, signal);
  await Promise.resolve();
  expect(f.call.mock.calls.filter(([method]) => method === "analysis.start")).toHaveLength(1);
  await f.client.call("analysis.cancel", { documentId: clip.documentId, jobId: clip.jobId });
  releaseAnalysis(f.client, clip.jobId);
  await later;
  expect(f.call.mock.calls.filter(([method]) => method === "analysis.start")).toHaveLength(2);
});
it("failed jobs do not poison the queue, and aborted queued work never creates a kernel job", async () => {
  const f = fixture();
  f.call.mockRejectedValueOnce(new Error("bad analysis"));
  await expect(analyse(f.client, params, new AbortController().signal)).rejects.toThrow(
    "bad analysis",
  );
  const abort = new AbortController();
  abort.abort();
  await expect(analyse(f.client, params, abort.signal)).rejects.toThrow("Analysis cancelled");
  await analyse(f.client, params, new AbortController().signal);
  expect(f.call.mock.calls.filter(([method]) => method === "analysis.start")).toHaveLength(2);
});
it("cancels its own started job before advancing after a failed bounded runner", async () => {
  const f = fixture();
  f.call.mockResolvedValueOnce({ ...params, jobId: "running", state: "running" });
  Object.assign(f.client, { runAnalysis: vi.fn().mockRejectedValue(new Error("step failed")) });
  await expect(analyse(f.client, params, new AbortController().signal)).rejects.toThrow(
    "step failed",
  );
  expect(f.call).toHaveBeenLastCalledWith("analysis.cancel", {
    documentId: "doc",
    jobId: "running",
  });
});
