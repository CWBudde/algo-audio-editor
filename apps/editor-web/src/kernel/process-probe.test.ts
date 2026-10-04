import type { ProcessJobResult } from "@aae/protocol";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkerReply } from "./messages";
import { installProcessProbe } from "./process-probe";

class ProbeWorker extends EventTarget {
  postMessage = vi.fn();
  reply(data: WorkerReply) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}
afterEach(() => {
  delete window.__aaeProcessProbe;
});

it("observes selected calls/progress, forwards transfers, reports failures and restores the worker", () => {
  installProcessProbe();
  const probe = window.__aaeProcessProbe;
  if (!probe) throw new Error("probe missing");
  const worker = new ProbeWorker();
  const native = worker.postMessage;
  const onProgress = vi.fn();
  const onReply = vi.fn();
  const onError = vi.fn();
  const observation = probe.observe(worker as unknown as Worker, {
    methods: ["process.run", "process.start"],
    onProgress,
    onReply,
    onError,
  });
  const buffer = new ArrayBuffer(4);
  worker.postMessage(
    { id: 1, op: "call", method: "process.start", params: { operation: "gain" } },
    [buffer],
  );
  expect(native).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), { transfer: [buffer] });
  worker.postMessage({ id: 2, op: "process.run", documentId: "doc", jobId: "job" });
  worker.postMessage({ id: 3, op: "call", method: "doc.info" });
  expect(observation.calls.size).toBe(2);
  worker.reply({
    kind: "process.progress",
    id: 99,
    progress: { state: "running" } as ProcessJobResult,
  });
  expect(onProgress).not.toHaveBeenCalled();
  const progress = { state: "ready" } as ProcessJobResult;
  worker.reply({ kind: "process.progress", id: 2, progress });
  expect(onProgress).toHaveBeenCalledWith(progress);
  worker.reply({ kind: "reply", id: 2, ok: true, result: progress });
  expect(onReply).toHaveBeenCalledWith(
    expect.objectContaining({
      method: "process.run",
      result: progress,
      endedAt: expect.any(Number),
    }),
  );
  worker.reply({ kind: "reply", id: 1, ok: false, error: "bad parameter" });
  expect(onError).toHaveBeenCalledWith(new Error("process.start: bad parameter"));
  worker.reply({ kind: "fatal", error: "kernel stopped" });
  expect(onError).toHaveBeenCalledWith(new Error("kernel stopped"));
  observation.dispose();
  expect(worker.postMessage).toBe(native);
  onProgress.mockClear();
  worker.reply({ kind: "process.progress", id: 2, progress });
  expect(onProgress).not.toHaveBeenCalled();
});

it("summarizes packed peaks with exact offsets and rejects incorrect lengths", () => {
  installProcessProbe();
  const probe = window.__aaeProcessProbe;
  if (!probe) throw new Error("probe missing");
  const data = new ArrayBuffer(24);
  new Float32Array(data, 0, 3).set([-0.5, 0.75, 0.25]);
  new Uint32Array(data, 12, 1)[0] = 100;
  new Float64Array(data, 16, 1)[0] = 2 ** 32 + 123;
  const peaks = { count: 1, dataBytes: 24, framesPerBucket: 100, data };
  expect(probe.summarizePeaks(peaks)).toEqual({
    count: 1,
    extrema: [[-0.5, 0.75]],
    ranges: [[2 ** 32 + 123, 100]],
  });
  expect(() => probe.summarizePeaks({ ...peaks, count: 2 })).toThrow(/packed peak/);
});

it("can delay selected calls without blocking controls, then releases requests in order", () => {
  installProcessProbe();
  const probe = window.__aaeProcessProbe;
  if (!probe) throw new Error("probe missing");
  const worker = new ProbeWorker();
  const native = worker.postMessage;
  const release = probe.holdCalls(worker as unknown as Worker, ["peaks.get"]);
  worker.postMessage({ id: 1, op: "call", method: "peaks.get" });
  worker.postMessage({ id: 2, op: "call", method: "doc.info" });
  worker.postMessage({ id: 3, op: "call", method: "peaks.get" });
  expect(native.mock.calls.map(([request]) => request.id)).toEqual([2]);
  release();
  expect(native.mock.calls.map(([request]) => request.id)).toEqual([2, 1, 3]);
  expect(worker.postMessage).toBe(native);
  release();
  expect(native).toHaveBeenCalledTimes(3);
});
