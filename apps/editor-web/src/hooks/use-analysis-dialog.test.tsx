import type { AnalysisJobResult } from "@aae/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { analyse, releaseAnalysis } from "@/kernel/analysis-queue";
import type { KernelClient } from "@/kernel/client";
import { useAnalysisDialog } from "./use-analysis-dialog";

vi.mock("@/kernel/analysis-queue", () => ({ analyse: vi.fn(), releaseAnalysis: vi.fn() }));
const info = {
  documentId: "doc",
  name: "tone.wav",
  channels: 2,
  frames: 100,
  sampleRate: 48000,
  bitDepth: 32,
  float: true,
};
const range = { start: 10, end: 30, channelMask: 2 };
const job: AnalysisJobResult = {
  ...range,
  documentId: "doc",
  jobId: "analysis",
  kind: "clipping",
  state: "ready",
  processedFrames: 20,
  totalFrames: 20,
  sampleRate: 48000,
  dataBytes: 0,
  channels: [1],
  integratedLUFS: null,
  markerCount: 2,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const call = vi.fn().mockResolvedValue({ document: info });
  const options = {
    client: { call } as unknown as KernelClient,
    info,
    busy: false,
    stateId: "original",
    beforeEdit: vi.fn().mockResolvedValue(undefined),
    withOperation: vi.fn(async (work: () => Promise<void>) => work()),
    onEdited: vi.fn(),
  };
  return {
    ...renderHook((props) => useAnalysisDialog(props), { initialProps: options }),
    options,
    call,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(analyse).mockResolvedValue(job);
});
afterEach(cleanup);
it("uses captured time/channel selection and holds the clipping reservation through one commit", async () => {
  const f = fixture();
  act(() => f.result.current.open("clipping", range));
  await waitFor(() => expect(f.result.current.view?.working).toBe(false));
  expect(vi.mocked(analyse).mock.calls[0][1]).toMatchObject({
    ...range,
    documentId: "doc",
    kind: "clipping",
  });
  expect(releaseAnalysis).not.toHaveBeenCalled();
  const pending = deferred<unknown>();
  f.call.mockReturnValueOnce(pending.promise);
  let saving: Promise<void> | undefined;
  act(() => {
    saving = f.result.current.commit();
  });
  await act(async () => Promise.resolve());
  expect(f.result.current.view?.committing).toBe(true);
  act(() => {
    f.result.current.cancel();
    void f.result.current.commit();
  });
  expect(f.call).toHaveBeenCalledTimes(1);
  await act(async () => {
    pending.resolve({ document: info });
    await saving;
  });
  expect(releaseAnalysis).toHaveBeenCalledWith(f.options.client, "analysis");
  expect(f.options.onEdited).toHaveBeenCalledOnce();
  expect(f.result.current.view).toBeUndefined();
});
it("keeps a failed clipping commit available for retry and releases it after cancel even when cancel fails", async () => {
  const f = fixture();
  act(() => f.result.current.open("clipping", range));
  await waitFor(() => expect(f.result.current.view?.working).toBe(false));
  f.call.mockRejectedValueOnce(new Error("marker budget exceeded"));
  await act(async () => f.result.current.commit());
  expect(f.result.current.view?.error).toBe("marker budget exceeded");
  expect(releaseAnalysis).not.toHaveBeenCalled();
  f.call.mockRejectedValueOnce(new Error("stale scratch"));
  await act(async () => f.result.current.cancel());
  expect(releaseAnalysis).toHaveBeenCalledWith(f.options.client, "analysis");
  expect(f.options.onEdited).not.toHaveBeenCalled();
});
it("aborts bounded work on same-length history changes and discards a late clipping result with its captured client", async () => {
  const pending = deferred<AnalysisJobResult>();
  vi.mocked(analyse).mockReturnValueOnce(pending.promise);
  const f = fixture();
  act(() => f.result.current.open("clipping", range));
  const signal = vi.mocked(analyse).mock.calls[0][2];
  f.rerender({ ...f.options, stateId: "edited" });
  expect(signal.aborted).toBe(true);
  expect(f.result.current.view).toBeUndefined();
  await act(async () => {
    pending.resolve(job);
  });
  expect(f.call).toHaveBeenCalledWith("analysis.cancel", { documentId: "doc", jobId: "analysis" });
  expect(releaseAnalysis).toHaveBeenCalledWith(f.options.client, "analysis");
});
it("does not commit after the operation fence yields to a replacement client", async () => {
  const f = fixture(),
    pause = deferred<void>();
  f.options.beforeEdit.mockReturnValueOnce(pause.promise);
  act(() => f.result.current.open("clipping", range));
  await waitFor(() => expect(f.result.current.view?.working).toBe(false));
  let pending: Promise<void> | undefined;
  act(() => {
    pending = f.result.current.commit();
  });
  f.rerender({ ...f.options, client: { call: vi.fn() } as unknown as KernelClient });
  await act(async () => {
    pause.resolve();
    await pending;
  });
  expect(f.call).not.toHaveBeenCalledWith("analysis.commit", expect.anything());
  expect(f.options.onEdited).not.toHaveBeenCalled();
});
