import type { DocumentInfoResult, EditResult, ProcessJobResult } from "@aae/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { KernelClient } from "@/kernel/client";
import { type ProcessOptions, parseGain, useProcess } from "./use-process";

const info: DocumentInfoResult = {
  documentId: "doc-1",
  name: "input.wav",
  sampleRate: 48000,
  channels: 2,
  frames: 100000,
  bitDepth: 32,
  float: true,
};
const range = { start: 2, end: 8, channelMask: 2 };
const result = { document: { ...info, documentId: "doc-2" }, changed: true } as EditResult;
const initialJob: ProcessJobResult = {
  documentId: info.documentId,
  ...range,
  jobId: "process-1",
  operation: "gain",
  gainDb: 6,
  state: "running",
  processedFrames: 0,
  totalFrames: 6,
  peak: 0,
  nonFinite: false,
};
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: Error) => void = () => {};
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function setup() {
  let held = false;
  let job = initialJob;
  const call = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
    if (method === "process.start") {
      const p = params as ProcessJobResult;
      const selection = p.start === p.end ? { start: 0, end: info.frames } : p;
      job = { ...initialJob, ...p, ...selection, totalFrames: selection.end - selection.start };
      return job;
    }
    if (method === "process.cancel") return { ...job, state: "cancelled" };
    if (method === "process.commit") return result;
    throw new Error(`Unexpected ${method}`);
  });
  const runProcess = vi.fn(
    async (): Promise<ProcessJobResult> => ({
      ...job,
      state: "ready",
      processedFrames: job.totalFrames,
      peak: 0.25,
    }),
  );
  const options: ProcessOptions = {
    client: { call, runProcess } as unknown as KernelClient,
    info,
    withOperation: vi.fn(async (work) => {
      held = true;
      try {
        await work();
      } finally {
        held = false;
      }
    }),
    beforeEdit: vi.fn().mockResolvedValue(undefined),
    preparePreview: vi.fn().mockResolvedValue(undefined),
    playPreview: vi.fn().mockResolvedValue(undefined),
    stopPreview: vi.fn().mockResolvedValue(undefined),
    onEdited: vi.fn(),
    onError: vi.fn(),
  };
  const view = renderHook((props: ProcessOptions) => useProcess(props), { initialProps: options });
  act(() => {
    view.result.current.open(range);
    view.result.current.setGainText("6");
  });
  return { ...view, options, call, runProcess, held: () => held };
}
afterEach(cleanup);

it.each(["", "NaN", "Infinity", "-121", "61"])("rejects invalid gain %s", (value) =>
  expect(parseGain(value)).toBeUndefined(),
);
it.each(["0", " -120 ", "60", "-6.5", "1e-3"])("accepts bounded gain %s", (value) =>
  expect(parseGain(value)).toBe(Number(value)),
);

it("holds a shared document lock, prepares under the gesture and previews without publishing", async () => {
  const s = setup();
  expect(s.held()).toBe(true);
  let pending: Promise<void> | undefined;
  act(() => {
    pending = s.result.current.preview();
  });
  expect(s.options.preparePreview).toHaveBeenCalledOnce();
  await act(async () => pending);
  expect(s.options.playPreview).toHaveBeenCalledWith(
    info,
    expect.objectContaining({ state: "ready", gainDb: 6 }),
  );
  expect(s.result.current.view).toMatchObject({ phase: "ready", previewing: true });
  expect(s.call.mock.calls.map(([method]) => method)).toEqual(["process.start"]);
  expect(s.options.onEdited).not.toHaveBeenCalled();
  expect(s.held()).toBe(true);
  await act(async () => s.result.current.cancel());
  expect(s.options.stopPreview).toHaveBeenCalledOnce();
  expect(s.options.onEdited).not.toHaveBeenCalled();
  expect(s.result.current.view).toBeUndefined();
  expect(s.held()).toBe(false);
});

it("commits only a ready job and publishes exactly one authoritative edit", async () => {
  const s = setup();
  await act(async () => s.result.current.apply());
  expect(s.call.mock.calls.map(([method]) => method)).toEqual(["process.start", "process.commit"]);
  expect(s.options.onEdited).toHaveBeenCalledExactlyOnceWith(result, info.documentId);
  expect(s.options.preparePreview).not.toHaveBeenCalled();
  expect(s.result.current.view).toBeUndefined();
  expect(s.held()).toBe(false);
});

it("requires a separate clipping acknowledgement and reuses the prepared candidate", async () => {
  const s = setup();
  s.runProcess.mockResolvedValue({ ...initialJob, state: "ready", processedFrames: 6, peak: 2 });
  await act(async () => s.result.current.apply());
  expect(s.result.current.view?.phase).toBe("ready");
  expect(s.call).not.toHaveBeenCalledWith("process.commit", expect.anything());
  await act(async () => s.result.current.apply(true));
  expect(s.runProcess).toHaveBeenCalledOnce();
  expect(s.options.onEdited).toHaveBeenCalledOnce();
});

it("changed parameters discard the old preview before building another candidate", async () => {
  const s = setup();
  await act(async () => s.result.current.preview());
  act(() => s.result.current.setGainText("-6"));
  await act(async () => s.result.current.preview());
  expect(s.call.mock.calls.map(([method]) => method)).toEqual([
    "process.start",
    "process.cancel",
    "process.start",
  ]);
  expect(s.call).toHaveBeenLastCalledWith("process.start", expect.objectContaining({ gainDb: -6 }));
  expect(s.options.beforeEdit).toHaveBeenCalledTimes(2);
  await act(async () => s.result.current.cancel());
});

it("cancels while slices are running and holds the lock through the terminal reply", async () => {
  const s = setup();
  const running = deferred<ProcessJobResult>();
  s.runProcess.mockReturnValue(running.promise);
  act(() => {
    void s.result.current.preview();
  });
  await waitFor(() => expect(s.runProcess).toHaveBeenCalledOnce());
  let closing: Promise<void> | undefined;
  act(() => {
    closing = s.result.current.cancel();
  });
  await waitFor(() => expect(s.call).toHaveBeenCalledWith("process.cancel", expect.anything()));
  expect(s.result.current.view?.phase).toBe("cancelling");
  expect(s.held()).toBe(true);
  await act(async () => {
    running.resolve({ ...initialJob, state: "cancelled" });
    await closing;
  });
  expect(s.held()).toBe(false);
  expect(s.options.playPreview).not.toHaveBeenCalled();
  expect(s.options.onEdited).not.toHaveBeenCalled();
});

it("cancellation before the start reply discards the eventual job without running or committing", async () => {
  const s = setup();
  const starting = deferred<ProcessJobResult>();
  s.call.mockImplementation(async (method) =>
    method === "process.start" ? starting.promise : { ...initialJob, state: "cancelled" },
  );
  act(() => {
    void s.result.current.preview();
  });
  await waitFor(() => expect(s.call).toHaveBeenCalledWith("process.start", expect.anything()));
  let closing: Promise<void> | undefined;
  act(() => {
    closing = s.result.current.cancel();
  });
  await act(async () => {
    starting.resolve(initialJob);
    await closing;
  });
  expect(s.runProcess).not.toHaveBeenCalled();
  expect(s.call).toHaveBeenCalledWith("process.cancel", {
    documentId: info.documentId,
    jobId: initialJob.jobId,
  });
  expect(s.options.onEdited).not.toHaveBeenCalled();
  expect(s.held()).toBe(false);
});

it("a successful in-flight commit wins a later Cancel request", async () => {
  const s = setup();
  const committing = deferred<EditResult>();
  const original = s.call.getMockImplementation();
  s.call.mockImplementation(async (method, params) =>
    method === "process.commit" ? committing.promise : original?.(method, params),
  );
  let applying: Promise<void> | undefined;
  act(() => {
    applying = s.result.current.apply();
  });
  await waitFor(() => expect(s.result.current.view?.phase).toBe("committing"));
  await act(async () => s.result.current.cancel());
  expect(s.held()).toBe(true);
  await act(async () => {
    committing.resolve(result);
    await applying;
  });
  expect(s.options.onEdited).toHaveBeenCalledExactlyOnceWith(result, info.documentId);
  expect(s.call).not.toHaveBeenCalledWith("process.cancel", expect.anything());
  expect(s.held()).toBe(false);
});

it("old preview cleanup stops its captured audio engine, not the replacement session's engine", async () => {
  const s = setup();
  await act(async () => s.result.current.preview());
  const stopNew = vi.fn().mockResolvedValue(undefined);
  s.rerender({ ...s.options, info: { ...info, documentId: "doc-new" }, stopPreview: stopNew });
  await waitFor(() => expect(s.held()).toBe(false));
  expect(s.options.stopPreview).toHaveBeenCalledOnce();
  expect(stopNew).not.toHaveBeenCalled();
  expect(s.options.onEdited).not.toHaveBeenCalled();
});

it("serializes Stop preview against another run and waits for it before closing", async () => {
  const s = setup();
  await act(async () => s.result.current.preview());
  const stopping = deferred<void>();
  vi.mocked(s.options.stopPreview).mockReturnValue(stopping.promise);
  act(() => {
    void s.result.current.stopPreview();
  });
  act(() => {
    void s.result.current.preview();
  });
  expect(s.options.preparePreview).toHaveBeenCalledOnce();
  let closing: Promise<void> | undefined;
  act(() => {
    closing = s.result.current.cancel();
  });
  expect(s.held()).toBe(true);
  await act(async () => {
    stopping.resolve();
    await closing;
  });
  expect(s.held()).toBe(false);
});

it("reports a failed preparation, keeps the dialog retryable and releases its lock on Cancel", async () => {
  const s = setup();
  vi.mocked(s.options.preparePreview).mockRejectedValue(new Error("audio permission"));
  await act(async () => s.result.current.preview());
  expect(s.options.onError).toHaveBeenCalledWith("Could not process audio", expect.any(Error));
  expect(s.call).not.toHaveBeenCalled();
  expect(s.result.current.view?.phase).toBe("idle");
  await act(async () => s.result.current.cancel());
  expect(s.held()).toBe(false);
});

it("displays the whole file for a cursor but sends the original range for history restoration", async () => {
  const s = setup();
  await act(async () => s.result.current.cancel());
  const cursor = { start: 41, end: 41, channelMask: 2 };
  act(() => s.result.current.open(cursor));
  expect(s.result.current.view?.selection).toEqual({ ...cursor, start: 0, end: info.frames });
  await act(async () => s.result.current.apply());
  expect(s.call).toHaveBeenCalledWith("process.start", expect.objectContaining(cursor));
});

it("an unexpected cancelled terminal reply leaves a retryable dialog and never commits", async () => {
  const s = setup();
  s.runProcess.mockResolvedValue({ ...initialJob, state: "cancelled" });
  await act(async () => s.result.current.apply());
  expect(s.result.current.view).toMatchObject({ phase: "idle", job: undefined });
  expect(s.options.onEdited).not.toHaveBeenCalled();
  expect(s.call).not.toHaveBeenCalledWith("process.commit", expect.anything());
  await act(async () => s.result.current.cancel());
  expect(s.held()).toBe(false);
});

it("a rejected commit discards its private candidate without publishing or releasing the modal lock", async () => {
  const s = setup();
  const original = s.call.getMockImplementation();
  s.call.mockImplementation(async (method, params) => {
    if (method === "process.commit") throw new Error("history budget");
    return original?.(method, params);
  });
  await act(async () => s.result.current.apply());
  expect(s.call).toHaveBeenCalledWith("process.cancel", expect.anything());
  expect(s.options.onEdited).not.toHaveBeenCalled();
  expect(s.options.onError).toHaveBeenCalledWith("Could not process audio", expect.any(Error));
  expect(s.result.current.view?.phase).toBe("idle");
  expect(s.held()).toBe(true);
  await act(async () => s.result.current.cancel());
  expect(s.held()).toBe(false);
});

it("unmount cancels a running job and waits for terminal ownership before releasing", async () => {
  const s = setup();
  const running = deferred<ProcessJobResult>();
  s.runProcess.mockReturnValue(running.promise);
  act(() => {
    void s.result.current.apply();
  });
  await waitFor(() => expect(s.runProcess).toHaveBeenCalledOnce());
  s.unmount();
  await waitFor(() => expect(s.call).toHaveBeenCalledWith("process.cancel", expect.anything()));
  expect(s.held()).toBe(true);
  await act(async () => running.resolve({ ...initialJob, state: "cancelled" }));
  await waitFor(() => expect(s.held()).toBe(false));
  expect(s.options.onEdited).not.toHaveBeenCalled();
});

it("a failed in-flight commit releases its stale session after the document is replaced", async () => {
  const s = setup();
  const committing = deferred<EditResult>();
  const original = s.call.getMockImplementation();
  s.call.mockImplementation(async (method, params) =>
    method === "process.commit" ? committing.promise : original?.(method, params),
  );
  let applying: Promise<void> | undefined;
  act(() => {
    applying = s.result.current.apply();
  });
  await waitFor(() => expect(s.result.current.view?.phase).toBe("committing"));
  const replacement = { ...s.options, info: { ...info, documentId: "doc-new" } };
  s.rerender(replacement);
  expect(s.held()).toBe(true);
  await act(async () => {
    committing.reject(new Error("old worker failed"));
    await applying;
  });
  expect(s.held()).toBe(false);
  expect(s.result.current.view).toBeUndefined();
  expect(s.options.onEdited).not.toHaveBeenCalled();
  act(() => s.result.current.open(range));
  expect(s.result.current.view?.info.documentId).toBe("doc-new");
  await act(async () => s.result.current.cancel());
  expect(s.held()).toBe(false);
});
