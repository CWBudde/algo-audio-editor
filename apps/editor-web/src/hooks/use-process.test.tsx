import type {
  DocumentInfoResult,
  EditResult,
  ProcessJobParams,
  ProcessJobResult,
  ProcessStartParams,
} from "@aae/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { KernelClient } from "@/kernel/client";
import {
  type ProcessOperation,
  type ProcessOptions,
  parseGain,
  parseProcessParameter,
  useProcess,
} from "./use-process";

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
  candidate: {
    sampleRate: info.sampleRate,
    channels: info.channels,
    frames: info.frames,
    ...range,
  },
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
  phase: "processing",
  phaseIndex: 0,
  phaseCount: 1,
  gainResolved: true,
  inputPeak: 0,
  inputLufs: null,
  predictedLufs: null,
  outputLufs: null,
  truePeak: null,
  planningSteps: 0,
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
function setup(operation: ProcessOperation = "gain", overrides: Partial<ProcessOptions> = {}) {
  let held = false;
  let job = initialJob;
  const call = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
    if (method === "process.start") {
      const p = params as ProcessStartParams;
      const selection = p.start === p.end ? { start: 0, end: info.frames } : p;
      job = {
        ...initialJob,
        ...p,
        ...selection,
        gainDb: p.operation === "gain" ? p.gainDb : 0,
        gainResolved: p.operation === "gain",
        phase: p.operation === "gain" ? "processing" : "analyzing",
        phaseCount: p.operation === "gain" ? 1 : p.operation === "normalize-peak" ? 2 : 3,
        totalFrames: selection.end - selection.start,
      };
      return job;
    }
    if (method === "process.cancel") return { ...job, state: "cancelled" };
    if (method === "process.commit") return result;
    throw new Error(`Unexpected ${method}`);
  });
  const runProcess = vi.fn(
    async (
      _params: ProcessJobParams,
      _onProgress?: (job: ProcessJobResult) => void,
    ): Promise<ProcessJobResult> => ({
      ...job,
      state: "ready",
      processedFrames: job.totalFrames,
      peak: 0.25,
      gainDb: job.operation === "gain" ? job.gainDb : 12,
      gainResolved: true,
      phase: job.operation === "normalize-loudness" ? "verifying" : "processing",
      phaseIndex: job.phaseCount - 1,
      inputPeak: 0.125,
      inputLufs: job.operation === "normalize-loudness" ? -35 : null,
      predictedLufs: job.operation === "normalize-loudness" ? (job.target ?? null) : null,
      outputLufs: job.operation === "normalize-loudness" ? (job.target ?? null) : null,
      truePeak: job.operation.startsWith("normalize") ? 0.3 : null,
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
    onRecorded: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
  const view = renderHook((props: ProcessOptions) => useProcess(props), { initialProps: options });
  act(() => {
    view.result.current.open(range, operation);
    if (operation === "gain") view.result.current.setParameterText("6");
  });
  return { ...view, options, call, runProcess, held: () => held };
}
afterEach(cleanup);

it("rebuilds a candidate when any fade setting changes and reuses the exact prepared settings", async () => {
  const s = setup("fade-in");
  await act(async () => s.result.current.preview());
  expect(s.result.current.view?.ready).toBe(true);
  act(() => s.result.current.setSettings({ curve: "equal-power" }));
  expect(s.result.current.view?.ready).toBe(false);
  await act(async () => s.result.current.preview());
  expect(s.call.mock.calls.filter(([method]) => method === "process.start")).toHaveLength(2);
  expect(s.call.mock.calls.filter(([method]) => method === "process.start")[1]?.[1]).toMatchObject({
    operation: "fade-in",
    curve: "equal-power",
  });
  await act(async () => s.result.current.apply());
  expect(s.call.mock.calls.filter(([method]) => method === "process.start")).toHaveLength(2);
  expect(s.options.onEdited).toHaveBeenCalledOnce();
  expect(s.options.onRecorded).toHaveBeenCalledOnce();
});

it("preserves a resolved noise seed between Preview and Apply", async () => {
  const s = setup("generate");
  act(() => s.result.current.setSettings({ generator: "white-noise" }));
  const seed = s.result.current.view?.settings?.seed;
  expect(Number.isInteger(seed)).toBe(true);
  await act(async () => s.result.current.preview());
  await act(async () => s.result.current.apply());
  const starts = s.call.mock.calls.filter(([method]) => method === "process.start");
  expect(starts).toHaveLength(1);
  expect(starts[0]?.[1]).toMatchObject({
    operation: "generate",
    generator: "white-noise",
    seed,
    durationFrames: 6,
  });
});

it("reserves the extracted window under the Apply gesture and leaves source history untouched", async () => {
  const prepareExtract = vi.fn();
  const onExtract = vi.fn().mockResolvedValue(undefined);
  const s = setup("extract-channel", { prepareExtract, onExtract });
  let pending: Promise<void> | undefined;
  act(() => {
    pending = s.result.current.apply();
  });
  expect(prepareExtract).toHaveBeenCalledOnce();
  expect(onExtract).not.toHaveBeenCalled();
  await act(async () => pending);
  expect(onExtract).toHaveBeenCalledWith(
    info,
    expect.objectContaining({ state: "ready", operation: "extract-channel" }),
  );
  expect(s.call.mock.calls.map(([method]) => method)).toEqual(["process.start", "process.cancel"]);
  expect(s.options.onEdited).not.toHaveBeenCalled();
  expect(s.options.onRecorded).toHaveBeenCalledWith(
    { method: "process.start", params: expect.objectContaining({ operation: "extract-channel" }) },
    info,
  );
  expect(s.result.current.view).toBeUndefined();
  expect(s.held()).toBe(false);
});

it("closes a reserved extraction window on failure and releases it on Cancel", async () => {
  const cancelExtract = vi.fn();
  const onExtract = vi.fn().mockRejectedValue(new Error("Destination closed"));
  const s = setup("extract-channel", { prepareExtract: vi.fn(), cancelExtract, onExtract });
  await act(async () => s.result.current.apply());
  expect(cancelExtract).toHaveBeenCalledOnce();
  expect(s.options.onError).toHaveBeenCalledWith("Could not process audio", expect.any(Error));
  expect(s.options.onEdited).not.toHaveBeenCalled();
  expect(s.options.onRecorded).not.toHaveBeenCalled();
  await act(async () => s.result.current.cancel());
  expect(cancelExtract).toHaveBeenCalledTimes(2);
  expect(s.held()).toBe(false);
});

it("opens generation for an empty document and sends insertion duration", async () => {
  const s = setup();
  await act(async () => s.result.current.cancel());
  s.rerender({ ...s.options, info: { ...info, frames: 0 } });
  act(() => s.result.current.open({ start: 0, end: 0, channelMask: 2 }, "generate"));
  expect(s.result.current.view?.selection).toEqual({ start: 0, end: 0, channelMask: 2 });
  await act(async () => s.result.current.apply());
  expect(s.call.mock.calls.find(([method]) => method === "process.start")?.[1]).toMatchObject({
    operation: "generate",
    start: 0,
    end: 0,
    durationFrames: 48000,
  });
});

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
  expect(s.options.onRecorded).not.toHaveBeenCalled();
  expect(s.held()).toBe(true);
  await act(async () => s.result.current.cancel());
  expect(s.options.stopPreview).toHaveBeenCalledOnce();
  expect(s.options.onEdited).not.toHaveBeenCalled();
  expect(s.options.onRecorded).not.toHaveBeenCalled();
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
  expect(s.options.onRecorded).toHaveBeenCalledOnce();
});

it.each([
  { peak: 2, nonFinite: false },
  { peak: 0, nonFinite: true },
])(
  "closes an unsafe extraction reservation while awaiting acknowledgement and reserves a fresh window on retry (%o)",
  async (warning) => {
    let reservation: number | undefined;
    let nextReservation = 0;
    const prepareExtract = vi.fn(() => {
      reservation = ++nextReservation;
    });
    const cancelExtract = vi.fn(() => {
      reservation = undefined;
    });
    const onExtract = vi.fn(async () => {
      expect(reservation).toBe(2);
    });
    const s = setup("extract-channel", { prepareExtract, cancelExtract, onExtract });
    s.runProcess.mockResolvedValue({
      ...initialJob,
      operation: "extract-channel",
      state: "ready",
      processedFrames: 6,
      ...warning,
    });
    await act(async () => s.result.current.apply());
    expect(prepareExtract).toHaveBeenCalledOnce();
    expect(cancelExtract).toHaveBeenCalledOnce();
    expect(reservation).toBeUndefined();
    expect(s.result.current.view?.phase).toBe("ready");
    expect(s.held()).toBe(true);
    expect(s.call.mock.calls.map(([method]) => method)).toEqual(["process.start"]);
    expect(s.options.onEdited).not.toHaveBeenCalled();
    expect(s.options.onRecorded).not.toHaveBeenCalled();
    expect(onExtract).not.toHaveBeenCalled();
    let pending: Promise<void> | undefined;
    act(() => {
      pending = s.result.current.apply(true);
    });
    expect(prepareExtract).toHaveBeenCalledTimes(2);
    expect(reservation).toBe(2);
    await act(async () => pending);
    expect(s.runProcess).toHaveBeenCalledOnce();
    expect(onExtract).toHaveBeenCalledOnce();
    expect(s.call.mock.calls.map(([method]) => method)).toEqual([
      "process.start",
      "process.cancel",
    ]);
    expect(s.options.onEdited).not.toHaveBeenCalled();
    expect(s.options.onRecorded).toHaveBeenCalledOnce();
    expect(s.held()).toBe(false);
  },
);

it("changed parameters discard the old preview before building another candidate", async () => {
  const s = setup();
  await act(async () => s.result.current.preview());
  act(() => s.result.current.setParameterText("-6"));
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
  expect(s.options.onRecorded).not.toHaveBeenCalled();
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
  expect(s.options.onRecorded).not.toHaveBeenCalled();
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
  expect(s.options.onRecorded).not.toHaveBeenCalled();
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

it("keeps preview startup busy until playback settles, then accepts Apply", async () => {
  const s = setup();
  const playing = deferred<void>();
  vi.mocked(s.options.playPreview).mockReturnValue(playing.promise);
  let preview: Promise<void> | undefined;
  act(() => {
    preview = s.result.current.preview();
  });
  await waitFor(() => expect(s.options.playPreview).toHaveBeenCalledOnce());
  expect(s.result.current.view).toMatchObject({ phase: "processing", previewing: false });
  await act(async () => {
    playing.resolve();
    await preview;
  });
  expect(s.result.current.view).toMatchObject({ phase: "ready", previewing: true });
  await act(async () => s.result.current.apply());
  expect(s.call).toHaveBeenCalledWith("process.commit", expect.anything());
  expect(s.result.current.view).toBeUndefined();
  expect(s.held()).toBe(false);
});

it("retains the modal until its document lock finishes releasing", async () => {
  const released = deferred<void>();
  const s = setup("gain", {
    withOperation: async (work) => {
      await work();
      await released.promise;
    },
  });
  let closing: Promise<void> | undefined;
  act(() => {
    closing = s.result.current.cancel();
  });
  await act(async () => {});
  expect(s.result.current.view?.phase).toBe("cancelling");
  await act(async () => {
    released.resolve();
    await closing;
  });
  expect(s.result.current.view).toBeUndefined();
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
  expect(s.options.onRecorded).not.toHaveBeenCalled();
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
  expect(s.options.onRecorded).not.toHaveBeenCalled();
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
  expect(s.options.onRecorded).not.toHaveBeenCalled();
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
  expect(s.options.onRecorded).not.toHaveBeenCalled();
  act(() => s.result.current.open(range));
  expect(s.result.current.view?.info.documentId).toBe("doc-new");
  await act(async () => s.result.current.cancel());
  expect(s.held()).toBe(false);
});

it.each([
  ["normalize-peak", "-120", -120],
  ["normalize-peak", "0", 0],
  ["normalize-loudness", "-69", -69],
  ["normalize-loudness", "-23", -23],
] as const)("accepts typed %s target %s", (operation, text, value) =>
  expect(parseProcessParameter(operation, text)).toBe(value),
);
it.each([
  ["normalize-peak", "-121"],
  ["normalize-peak", "1"],
  ["normalize-loudness", "-70"],
  ["normalize-loudness", "0.1"],
  ["normalize-loudness", "Infinity"],
  ["normalize-peak", ""],
] as const)("rejects typed %s target %s", (operation, text) =>
  expect(parseProcessParameter(operation, text)).toBeUndefined(),
);

it("opens Normalize with peak default and permits only normalization mode switches", async () => {
  const s = setup("normalize-peak");
  expect(s.result.current.view).toMatchObject({ operation: "normalize-peak", parameterText: "-1" });
  act(() => s.result.current.setOperation("normalize-loudness"));
  expect(s.result.current.view).toMatchObject({
    operation: "normalize-loudness",
    parameterText: "-23",
  });
  act(() => s.result.current.setOperation("normalize-peak"));
  expect(s.result.current.view?.parameterText).toBe("-1");
  await act(async () => s.result.current.cancel());
  const gain = setup();
  act(() => gain.result.current.setOperation("normalize-loudness"));
  expect(gain.result.current.view?.operation).toBe("gain");
  await act(async () => gain.result.current.cancel());
});

it.each(["normalize-peak", "normalize-loudness"] as const)(
  "reuses %s candidate by requested target rather than resolved gain",
  async (operation) => {
    const s = setup(operation);
    await act(async () => s.result.current.preview());
    expect(s.call).toHaveBeenCalledWith("process.start", {
      documentId: info.documentId,
      ...range,
      operation,
      target: operation === "normalize-peak" ? -1 : -23,
    });
    expect(s.result.current.view?.job?.gainDb).toBe(12);
    await act(async () => s.result.current.apply());
    expect(s.runProcess).toHaveBeenCalledOnce();
    expect(s.options.onEdited).toHaveBeenCalledOnce();
    expect(s.options.onRecorded).toHaveBeenCalledOnce();
    expect(s.held()).toBe(false);
  },
);

it("target and mode changes discard stale preview/candidate before rebuilding", async () => {
  const s = setup("normalize-peak");
  await act(async () => s.result.current.preview());
  act(() => s.result.current.setParameterText("-6"));
  await act(async () => s.result.current.preview());
  expect(s.call).toHaveBeenLastCalledWith(
    "process.start",
    expect.objectContaining({ operation: "normalize-peak", target: -6 }),
  );
  act(() => s.result.current.setOperation("normalize-loudness"));
  await act(async () => s.result.current.preview());
  expect(s.call).toHaveBeenLastCalledWith(
    "process.start",
    expect.objectContaining({ operation: "normalize-loudness", target: -23 }),
  );
  expect(s.call.mock.calls.filter(([method]) => method === "process.cancel")).toHaveLength(2);
  await act(async () => s.result.current.cancel());
});

it.each(["analyzing", "processing", "verifying"] as const)(
  "cancels normalization during %s while retaining ownership through terminal reply",
  async (phase) => {
    const s = setup("normalize-loudness");
    const running = deferred<ProcessJobResult>();
    let progress: ProcessJobResult | undefined;
    s.runProcess.mockImplementation((_, onProgress) => {
      progress = {
        ...initialJob,
        operation: "normalize-loudness",
        target: -23,
        phase,
        phaseIndex: phase === "analyzing" ? 0 : phase === "processing" ? 1 : 2,
        phaseCount: 3,
        gainResolved: phase !== "analyzing",
        gainDb: phase === "analyzing" ? 0 : 12,
        processedFrames: 2,
        inputPeak: 0.125,
        inputLufs: phase === "analyzing" ? null : -35,
        predictedLufs: phase === "analyzing" ? null : -23,
      };
      onProgress?.(progress);
      return running.promise;
    });
    act(() => {
      void s.result.current.apply();
    });
    await waitFor(() => expect(s.result.current.view?.job?.phase).toBe(phase));
    act(() => s.result.current.setOperation("normalize-peak"));
    expect(s.result.current.view?.operation).toBe("normalize-loudness");
    let closing: Promise<void> | undefined;
    act(() => {
      closing = s.result.current.cancel();
    });
    await waitFor(() => expect(s.call).toHaveBeenCalledWith("process.cancel", expect.anything()));
    expect(s.held()).toBe(true);
    await act(async () => {
      running.resolve({ ...(progress as ProcessJobResult), state: "cancelled" });
      await closing;
    });
    expect(s.options.onEdited).not.toHaveBeenCalled();
    expect(s.options.onRecorded).not.toHaveBeenCalled();
    expect(s.held()).toBe(false);
  },
);

it.each(["too short", "nonfinite input", "unstable target"])(
  "normalization %s failure cleans candidate but keeps retryable dialog",
  async (message) => {
    const s = setup("normalize-loudness");
    s.runProcess.mockRejectedValue(new Error(message));
    await act(async () => s.result.current.apply());
    expect(s.call).toHaveBeenCalledWith("process.cancel", expect.anything());
    expect(s.result.current.view).toMatchObject({ phase: "idle", job: undefined });
    expect(s.options.onEdited).not.toHaveBeenCalled();
    expect(s.options.onRecorded).not.toHaveBeenCalled();
    expect(s.held()).toBe(true);
    await act(async () => s.result.current.cancel());
  },
);

it("silent normalization commits the authoritative unchanged result without inventing a metric", async () => {
  const s = setup("normalize-loudness");
  s.runProcess.mockResolvedValue({
    ...initialJob,
    operation: "normalize-loudness",
    target: -23,
    state: "ready",
    phase: "verifying",
    phaseIndex: 2,
    phaseCount: 3,
    gainResolved: true,
    gainDb: 0,
    unchangedReason: "silent",
    processedFrames: 6,
    peak: 0,
    inputPeak: 0,
    inputLufs: null,
    predictedLufs: null,
    outputLufs: null,
  });
  const original = s.call.getMockImplementation();
  const unchanged = { ...result, document: info, changed: false };
  s.call.mockImplementation(async (method, params) =>
    method === "process.commit" ? unchanged : original?.(method, params),
  );
  await act(async () => s.result.current.apply());
  expect(s.options.onEdited).toHaveBeenCalledExactlyOnceWith(unchanged, info.documentId);
  expect(s.held()).toBe(false);
});

it("records the kernel-resolved whole range when processing a cursor", async () => {
  const s = setup("gain");
  await act(async () => s.result.current.cancel());
  act(() => {
    s.result.current.open({ start: 4, end: 4, channelMask: 2 }, "gain");
    s.result.current.setParameterText("6");
  });
  await act(async () => s.result.current.apply());
  expect(s.options.onRecorded).toHaveBeenCalledExactlyOnceWith(
    {
      method: "process.start",
      params: {
        documentId: info.documentId,
        operation: "gain",
        gainDb: 6,
        start: 0,
        end: info.frames,
        channelMask: 2,
      },
    },
    info,
  );
});

it("refreshes document info when a successful commit outlives its session identity", async () => {
  const refreshDocument = vi.fn().mockResolvedValue(undefined);
  const s = setup("gain", { refreshDocument });
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
  s.rerender({ ...s.options, info: { ...info, documentId: "doc-new" } });
  await act(async () => {
    committing.resolve(result);
    await applying;
  });
  expect(refreshDocument).toHaveBeenCalledExactlyOnceWith(s.options.client);
  expect(s.options.onEdited).not.toHaveBeenCalled();
  expect(s.options.onRecorded).not.toHaveBeenCalled();
  expect(s.held()).toBe(false);
});

it("builds a candidate from a supplied source, reuses it for Apply and records the source's request", async () => {
  const s = setup("generate");
  const recorded = {
    method: "process.start" as const,
    params: { documentId: info.documentId, ...range, operation: "reverse" as const },
  };
  const start = vi.fn(async () => ({ ...initialJob, operation: "generate" as const }));
  const source = { key: "speech-a", start, recorded };
  await act(async () => s.result.current.runSource("prepare", source));
  expect(start).toHaveBeenCalledWith(s.options.client, info, range, expect.any(AbortSignal));
  expect(s.result.current.view).toMatchObject({ phase: "ready", preparedKey: "speech-a" });
  expect(s.options.playPreview).not.toHaveBeenCalled();
  expect(s.call).not.toHaveBeenCalledWith("process.commit", expect.anything());
  await act(async () => s.result.current.runSource("apply", source));
  expect(start).toHaveBeenCalledTimes(1);
  expect(s.call).toHaveBeenCalledWith("process.commit", {
    documentId: info.documentId,
    jobId: initialJob.jobId,
  });
  expect(s.options.onRecorded).toHaveBeenCalledWith(recorded, info);
});

it("Cancel aborts a source that has not produced a job and does not report the abort", async () => {
  const s = setup("generate");
  let aborted = false;
  const start = vi.fn(
    (_client: unknown, _info: unknown, _selection: unknown, signal: AbortSignal) =>
      new Promise<ProcessJobResult>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("cancelled", "AbortError"));
        });
      }),
  );
  act(() => {
    void s.result.current.runSource("prepare", {
      key: "speech-b",
      start,
      recorded: {
        method: "process.start",
        params: { documentId: "x", ...range, operation: "reverse" },
      },
    });
  });
  await waitFor(() => expect(start).toHaveBeenCalled());
  await act(async () => s.result.current.cancel());
  expect(aborted).toBe(true);
  expect(s.options.onError).not.toHaveBeenCalled();
  expect(s.runProcess).not.toHaveBeenCalled();
  expect(s.result.current.view).toBeUndefined();
  expect(s.held()).toBe(false);
});
