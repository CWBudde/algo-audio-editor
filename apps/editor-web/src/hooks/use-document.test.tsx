import type { DocumentInfoResult, ExportResult, HistoryListResult } from "@aae/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KernelClient, type WorkerLike } from "@/kernel/client";
import type { WorkerReply, WorkerRequest } from "@/kernel/messages";
import { chooseAudioFile, chooseSaveTarget } from "@/lib/file-access";
import { useDocument } from "./use-document";

vi.mock("@/lib/file-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/file-access")>()),
  chooseAudioFile: vi.fn(),
  chooseSaveTarget: vi.fn(),
}));

const info: DocumentInfoResult = {
  documentId: "doc-1",
  name: "stereo.wav",
  sampleRate: 44100,
  channels: 2,
  frames: 4,
  bitDepth: 24,
  float: false,
};
const exported: ExportResult = {
  name: info.name,
  mimeType: "audio/wav",
  dataBytes: 8,
  data: new ArrayBuffer(8),
};
const dirtyHistory: HistoryListResult = {
  documentId: info.documentId,
  currentStateId: "state-2",
  savedStateId: "state-1",
  dirty: true,
  canUndo: true,
  canRedo: false,
  entries: [
    { stateId: "state-1", label: "Opened document" },
    { stateId: "state-2", label: "Mute" },
  ],
  maxEntries: 100,
  maxBytes: 512 << 20,
  retainedBytes: 64,
};
const cleanHistory = { ...dirtyHistory, savedStateId: "state-2", dirty: false };

class DocumentWorker implements WorkerLike {
  sent: WorkerRequest[] = [];
  private listener?: (event: MessageEvent<WorkerReply>) => void;
  rejectOpen = false;
  holdInfo = false;
  holdSave = false;
  rejectExport = false;
  rejectSave = false;
  postMessage(request: WorkerRequest) {
    this.sent.push(request);
    if (request.op !== "call") return;
    if (request.method === "doc.info" && this.holdInfo) return;
    if (request.method === "doc.mark-saved" && this.holdSave) return;
    const reply: WorkerReply =
      request.method === "doc.info" ||
      (request.method === "doc.open" && this.rejectOpen) ||
      ((request.method === "doc.export" || request.method === "timeline.export") &&
        this.rejectExport) ||
      (request.method === "doc.mark-saved" && this.rejectSave)
        ? { kind: "reply", id: request.id, ok: false, error: "invalid document" }
        : {
            kind: "reply",
            id: request.id,
            ok: true,
            result:
              request.method === "doc.export" || request.method === "timeline.export"
                ? exported
                : request.method === "history.list"
                  ? dirtyHistory
                  : request.method === "doc.mark-saved"
                    ? cleanHistory
                    : { ...info, name: (request.params as { name: string }).name },
          };
    queueMicrotask(() => this.emit(reply));
  }
  addEventListener(_type: "message", listener: (event: MessageEvent<WorkerReply>) => void) {
    this.listener = listener;
  }
  terminate() {}
  emit(reply: WorkerReply) {
    this.listener?.({ data: reply } as MessageEvent<WorkerReply>);
  }
}

function wavBytes(size: number) {
  const bytes = new ArrayBuffer(size);
  new Uint8Array(bytes).set([82, 73, 70, 70]);
  return bytes;
}

function file(name = info.name, read = () => Promise.resolve(wavBytes(4))) {
  const result = new File(["wave"], name);
  Object.defineProperty(result, "arrayBuffer", {
    value: vi.fn(read),
  });
  return result;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function opened(worker: DocumentWorker) {
  return worker.sent.filter((request) => request.op === "call" && request.method === "doc.open");
}

function options() {
  return {
    beforeOpen: vi.fn().mockResolvedValue(undefined),
    fallbackOpen: vi.fn(),
    reportError: vi.fn(),
    onSaved: vi.fn(),
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("useDocument", () => {
  it("holds the document lock while fetching the demo and ignores duplicate opens", async () => {
    const fetching = deferred<Response>();
    const fetchDemo = vi.fn().mockReturnValue(fetching.promise);
    vi.stubGlobal("fetch", fetchDemo);
    vi.stubGlobal(
      "File",
      class extends File {
        arrayBuffer() {
          return Promise.resolve(wavBytes(4));
        }
      },
    );
    const worker = new DocumentWorker();
    const callbacks = options();
    const client = new KernelClient(worker);
    const { result } = renderHook(() => useDocument(client, callbacks));
    act(() => {
      result.current.openDemo();
      result.current.openDemo();
    });
    expect(fetchDemo).toHaveBeenCalledTimes(1);
    expect(fetchDemo).toHaveBeenCalledWith(`${import.meta.env.BASE_URL}demo.wav`);
    expect(result.current.busy).toBe(true);
    await act(async () =>
      fetching.resolve({ ok: true, blob: async () => new Blob(["RIFF"]) } as Response),
    );
    expect(opened(worker)).toHaveLength(1);
    expect(result.current.info?.name).toBe("demo.wav");
    expect(callbacks.beforeOpen).toHaveBeenCalledTimes(1);
    expect(result.current.busy).toBe(false);
  });

  it("rejects a failed demo fetch without importing and releases the lock for retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const worker = new DocumentWorker();
    const client = new KernelClient(worker);
    const callbacks = options();
    const { result } = renderHook(() => useDocument(client, callbacks));
    await act(async () => result.current.openDemo());
    expect(callbacks.reportError).toHaveBeenCalledWith("Could not open demo", expect.any(Error));
    expect(callbacks.beforeOpen).not.toHaveBeenCalled();
    expect(opened(worker)).toHaveLength(0);
    expect(result.current.busy).toBe(false);
    await act(async () => result.current.openFile(file()));
    expect(opened(worker)).toHaveLength(1);
  });

  it("drops a demo response after the kernel session is replaced", async () => {
    const fetching = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(fetching.promise));
    const worker = new DocumentWorker();
    const client = new KernelClient(worker);
    const callbacks = options();
    const { result, rerender } = renderHook(({ client }) => useDocument(client, callbacks), {
      initialProps: { client },
    });
    act(() => result.current.openDemo());
    const replacement = new DocumentWorker();
    rerender({ client: new KernelClient(replacement) });
    await act(async () =>
      fetching.resolve({ ok: true, blob: async () => new Blob(["RIFF"]) } as Response),
    );
    expect(opened(worker)).toHaveLength(0);
    expect(opened(replacement)).toHaveLength(0);
    expect(callbacks.beforeOpen).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
  });

  it("holds the shared edit lock through confirmation and rejects overlapping file/edit operations", async () => {
    const worker = new DocumentWorker();
    const client = new KernelClient(worker);
    const { result } = renderHook(() => useDocument(client, options()));
    await act(async () => result.current.openFile(file()));
    const pending = deferred<void>();
    let editing: Promise<void> = Promise.resolve();
    act(() => {
      editing = result.current.withOperation(() => pending.promise);
    });
    expect(result.current.busy).toBe(true);
    const ignored = file("ignored.wav");
    act(() => result.current.openFile(ignored));
    expect(ignored.arrayBuffer).not.toHaveBeenCalled();
    const work = vi.fn().mockResolvedValue(undefined);
    await expect(result.current.withOperation(work)).rejects.toThrow("in progress");
    expect(work).not.toHaveBeenCalled();
    await act(async () => {
      pending.resolve(undefined);
      await editing;
    });
    expect(result.current.busy).toBe(false);
  });

  it("releases the shared edit lock on failure without reporting an extra file error", async () => {
    const worker = new DocumentWorker();
    const callbacks = options();
    const client = new KernelClient(worker);
    const { result } = renderHook(() => useDocument(client, callbacks));
    const failure = new Error("edit failed");
    await act(async () => {
      await expect(
        result.current.withOperation(async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
    });
    expect(result.current.busy).toBe(false);
    expect(callbacks.reportError).not.toHaveBeenCalled();
    await act(async () => result.current.openFile(file()));
    expect(result.current.info).toEqual(info);
  });

  it("accepts edited metadata only for the current document and ignores stale initialization", async () => {
    const worker = new DocumentWorker();
    worker.holdInfo = true;
    const client = new KernelClient(worker);
    const { result } = renderHook(() => useDocument(client, options()));
    await act(async () => result.current.openFile(file()));
    const changed = { ...info, documentId: "doc-2", frames: 8 };
    act(() => result.current.replaceInfo(changed, "obsolete"));
    expect(result.current.info).toEqual(info);
    act(() => result.current.replaceInfo(changed, info.documentId));
    expect(result.current.info).toEqual(changed);
    await act(async () =>
      worker.emit({ kind: "reply", id: worker.sent[0].id, ok: true, result: info }),
    );
    expect(result.current.info).toEqual(changed);
    act(() => result.current.replaceInfo(info, info.documentId));
    expect(result.current.info).toEqual(changed);
  });

  it("does not let a replaced client's old edit lock release a newer import", async () => {
    const oldClient = new KernelClient(new DocumentWorker());
    const newWorker = new DocumentWorker();
    const newClient = new KernelClient(newWorker);
    const { result, rerender } = renderHook(({ client }) => useDocument(client, options()), {
      initialProps: { client: oldClient },
    });
    const oldWork = deferred<void>();
    let editing: Promise<void> = Promise.resolve();
    act(() => {
      editing = result.current.withOperation(() => oldWork.promise);
    });
    rerender({ client: newClient });
    const reading = deferred<ArrayBuffer>();
    await act(async () => result.current.openFile(file("new.wav", () => reading.promise)));
    await act(async () => {
      oldWork.resolve(undefined);
      await editing;
    });
    expect(result.current.busy).toBe(true);
    await act(async () => reading.resolve(wavBytes(4)));
    expect(result.current.info?.name).toBe("new.wav");
    expect(result.current.busy).toBe(false);
  });

  it("starts playback shutdown before reading and opens the binary document after both", async () => {
    const worker = new DocumentWorker();
    const client = new KernelClient(worker);
    const callbacks = options();
    const { result } = renderHook(() => useDocument(client, callbacks));
    const selected = file();
    await act(async () => result.current.openFile(selected));
    expect(callbacks.beforeOpen).toHaveBeenCalledTimes(1);
    expect(vi.mocked(callbacks.beforeOpen).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(selected.arrayBuffer).mock.invocationCallOrder[0],
    );
    expect(result.current.info).toEqual(info);
    expect(result.current.busy).toBe(false);
    expect(
      worker.sent.find((request) => request.op === "call" && request.method === "doc.open"),
    ).toMatchObject({ data: expect.any(ArrayBuffer), params: { name: info.name } });
  });

  it("starts file reading while shutdown is pending and waits for both before opening", async () => {
    const worker = new DocumentWorker();
    const client = new KernelClient(worker);
    const callbacks = options();
    const stopping = deferred<void>();
    const reading = deferred<ArrayBuffer>();
    callbacks.beforeOpen.mockReturnValue(stopping.promise);
    const selected = file("overlap.wav", () => reading.promise);
    const { result } = renderHook(() => useDocument(client, callbacks));
    await act(async () => result.current.openFile(selected));
    expect(selected.arrayBuffer).toHaveBeenCalledOnce();
    expect(callbacks.beforeOpen).toHaveBeenCalledOnce();
    expect(result.current.busy).toBe(true);
    expect(opened(worker)).toHaveLength(0);
    const bytes = wavBytes(8);
    await act(async () => reading.resolve(bytes));
    expect(opened(worker)).toHaveLength(0);
    expect(result.current.busy).toBe(true);
    await act(async () => stopping.resolve(undefined));
    expect(opened(worker)).toHaveLength(1);
    expect(opened(worker)[0]).toMatchObject({ data: bytes, params: { name: "overlap.wav" } });
    expect(result.current.info?.name).toBe("overlap.wav");
    expect(result.current.busy).toBe(false);
  });

  it("keeps imports serialized when shutdown finishes before file reading", async () => {
    const worker = new DocumentWorker();
    const client = new KernelClient(worker);
    const callbacks = options();
    const reading = deferred<ArrayBuffer>();
    const ignored = file("ignored.wav");
    const { result } = renderHook(() => useDocument(client, callbacks));
    await act(async () => result.current.openFile(file("reading.wav", () => reading.promise)));
    expect(result.current.busy).toBe(true);
    act(() => result.current.openFile(ignored));
    expect(callbacks.beforeOpen).toHaveBeenCalledOnce();
    expect(ignored.arrayBuffer).not.toHaveBeenCalled();
    expect(opened(worker)).toHaveLength(0);
    await act(async () => reading.resolve(wavBytes(4)));
    expect(result.current.info?.name).toBe("reading.wav");
    expect(result.current.busy).toBe(false);
  });

  it("handles an early read rejection and keeps the import lock until shutdown settles", async () => {
    const worker = new DocumentWorker();
    const client = new KernelClient(worker);
    const callbacks = options();
    const { result } = renderHook(() => useDocument(client, callbacks));
    await act(async () => result.current.openFile(file()));
    const stopping = deferred<void>();
    const reading = deferred<ArrayBuffer>();
    callbacks.beforeOpen.mockReturnValue(stopping.promise);
    await act(async () => result.current.openFile(file("unreadable.wav", () => reading.promise)));
    const failure = new Error("file read failed");
    await act(async () => reading.reject(failure));
    expect(result.current.busy).toBe(true);
    expect(callbacks.reportError).not.toHaveBeenCalled();
    const ignored = file("ignored.wav");
    act(() => result.current.openFile(ignored));
    expect(ignored.arrayBuffer).not.toHaveBeenCalled();
    await act(async () => stopping.resolve(undefined));
    expect(opened(worker)).toHaveLength(1);
    expect(result.current.info).toEqual(info);
    expect(result.current.busy).toBe(false);
    expect(callbacks.reportError).toHaveBeenCalledExactlyOnceWith("Could not open audio", failure);
  });

  it("handles shutdown failure without releasing the lock while reading is still pending", async () => {
    const worker = new DocumentWorker();
    const client = new KernelClient(worker);
    const callbacks = options();
    const stopping = deferred<void>();
    const reading = deferred<ArrayBuffer>();
    callbacks.beforeOpen.mockReturnValue(stopping.promise);
    const { result } = renderHook(() => useDocument(client, callbacks));
    await act(async () => result.current.openFile(file("stopped.wav", () => reading.promise)));
    const failure = new Error("shutdown failed");
    await act(async () => stopping.reject(failure));
    expect(result.current.busy).toBe(true);
    expect(callbacks.reportError).not.toHaveBeenCalled();
    await act(async () => reading.reject(new Error("read also failed")));
    expect(opened(worker)).toHaveLength(0);
    expect(result.current.busy).toBe(false);
    expect(callbacks.reportError).toHaveBeenCalledExactlyOnceWith("Could not open audio", failure);
  });

  it("ignores overlapping results and read errors after unmount", async () => {
    const worker = new DocumentWorker();
    const client = new KernelClient(worker);
    const callbacks = options();
    const stopping = deferred<void>();
    const reading = deferred<ArrayBuffer>();
    callbacks.beforeOpen.mockReturnValue(stopping.promise);
    const selected = file("unmounted.wav", () => reading.promise);
    const { result, unmount } = renderHook(() => useDocument(client, callbacks));
    await act(async () => result.current.openFile(selected));
    expect(selected.arrayBuffer).toHaveBeenCalledOnce();
    unmount();
    await act(async () => {
      reading.reject(new Error("late read failed"));
      stopping.resolve(undefined);
    });
    expect(opened(worker)).toHaveLength(0);
    expect(callbacks.reportError).not.toHaveBeenCalled();
  });

  it("does not let an old client's overlapping import release a new client's active lock", async () => {
    const oldWorker = new DocumentWorker();
    const oldClient = new KernelClient(oldWorker);
    const newWorker = new DocumentWorker();
    const newClient = new KernelClient(newWorker);
    const callbacks = options();
    const stopping = deferred<void>();
    const oldReading = deferred<ArrayBuffer>();
    const newReading = deferred<ArrayBuffer>();
    callbacks.beforeOpen.mockReturnValueOnce(stopping.promise);
    const { result, rerender } = renderHook(({ client }) => useDocument(client, callbacks), {
      initialProps: { client: oldClient },
    });
    await act(async () => result.current.openFile(file("old.wav", () => oldReading.promise)));
    rerender({ client: newClient });
    await act(async () => result.current.openFile(file("new.wav", () => newReading.promise)));
    await act(async () => {
      oldReading.reject(new Error("obsolete read failed"));
      stopping.resolve(undefined);
    });
    expect(result.current.busy).toBe(true);
    expect(result.current.info).toBeUndefined();
    expect(opened(oldWorker)).toHaveLength(0);
    expect(opened(newWorker)).toHaveLength(0);
    expect(callbacks.reportError).not.toHaveBeenCalled();
    const ignored = file("ignored.wav");
    act(() => result.current.openFile(ignored));
    expect(ignored.arrayBuffer).not.toHaveBeenCalled();
    await act(async () => newReading.resolve(wavBytes(4)));
    expect(result.current.info?.name).toBe("new.wav");
    expect(result.current.busy).toBe(false);
  });

  it("treats shutdown cancellation as a cancelled import after the overlapping read settles", async () => {
    const worker = new DocumentWorker();
    const client = new KernelClient(worker);
    const callbacks = options();
    const stopping = deferred<void>();
    const reading = deferred<ArrayBuffer>();
    callbacks.beforeOpen.mockReturnValue(stopping.promise);
    const { result } = renderHook(() => useDocument(client, callbacks));
    await act(async () => result.current.openFile(file("cancelled.wav", () => reading.promise)));
    await act(async () => stopping.reject(new DOMException("Cancelled", "AbortError")));
    expect(result.current.busy).toBe(true);
    await act(async () => reading.resolve(wavBytes(4)));
    expect(opened(worker)).toHaveLength(0);
    expect(result.current.busy).toBe(false);
    expect(callbacks.reportError).not.toHaveBeenCalled();
  });

  it("ignores repeated opens while an operation is busy", async () => {
    const worker = new DocumentWorker();
    const client = new KernelClient(worker);
    const callbacks = options();
    let finishStop: (() => void) | undefined;
    callbacks.beforeOpen.mockReturnValue(
      new Promise<void>((resolve) => {
        finishStop = resolve;
      }),
    );
    const { result } = renderHook(() => useDocument(client, callbacks));
    act(() => {
      result.current.openFile(file("first.wav"));
      result.current.openFile(file("second.wav"));
    });
    expect(result.current.busy).toBe(true);
    expect(callbacks.beforeOpen).toHaveBeenCalledTimes(1);
    await act(async () => finishStop?.());
    expect(result.current.info?.name).toBe("first.wav");
  });

  it("keeps the previous document after a failed import and reports the error", async () => {
    const worker = new DocumentWorker();
    const client = new KernelClient(worker);
    const callbacks = options();
    const { result } = renderHook(() => useDocument(client, callbacks));
    await act(async () => result.current.openFile(file()));
    worker.rejectOpen = true;
    await act(async () => result.current.openFile(file("broken.wav")));
    expect(result.current.info).toEqual(info);
    expect(callbacks.reportError).toHaveBeenCalledWith("Could not open audio", expect.any(Error));
    expect(result.current.busy).toBe(false);
  });

  it("saves in the source format and writes the received buffer without conversion", async () => {
    const worker = new DocumentWorker();
    const client = new KernelClient(worker);
    const write = vi.fn().mockResolvedValue(undefined);
    vi.mocked(chooseSaveTarget).mockResolvedValue({ write });
    const { result } = renderHook(() => useDocument(client, options()));
    await act(async () => result.current.openFile(file()));
    await act(async () => result.current.save());
    expect(chooseSaveTarget).toHaveBeenCalledWith(info.name, [
      { description: "WAV audio", accept: { "audio/wav": [".wav"] } },
    ]);
    expect(
      worker.sent.find((request) => request.op === "call" && request.method === "doc.export"),
    ).toMatchObject({ params: { format: "wav", bitDepth: 24, float: false } });
    expect(write).toHaveBeenCalledWith(exported);
  });

  it.each(["csv", "labels"] as const)(
    "exports %s sidecars under the shared file lock without marking saved",
    async (format) => {
      const worker = new DocumentWorker();
      const client = new KernelClient(worker);
      const callbacks = options();
      const writing = deferred<void>();
      const write = vi.fn(() => writing.promise);
      vi.mocked(chooseSaveTarget).mockResolvedValue({ write });
      const { result } = renderHook(() => useDocument(client, callbacks));
      await act(async () => result.current.openFile(file()));
      const original = result.current.info;
      await act(async () => result.current.exportTimeline(format));
      expect(result.current.busy).toBe(true);
      expect(chooseSaveTarget).toHaveBeenCalledWith(
        `stereo.${format === "csv" ? "markers.csv" : "labels.txt"}`,
        expect.arrayContaining([
          expect.objectContaining({
            accept: {
              [format === "csv" ? "text/csv" : "text/plain"]: [format === "csv" ? ".csv" : ".txt"],
            },
          }),
        ]),
      );
      expect(
        worker.sent.find(
          (request) => request.op === "call" && request.method === "timeline.export",
        ),
      ).toMatchObject({ params: { documentId: info.documentId, format } });
      const ignored = file("ignored.wav");
      act(() => result.current.openFile(ignored));
      expect(ignored.arrayBuffer).not.toHaveBeenCalled();
      await expect(result.current.withOperation(async () => {})).rejects.toThrow("in progress");
      await act(async () => writing.resolve(undefined));
      expect(result.current.busy).toBe(false);
      expect(result.current.info).toBe(original);
      expect(callbacks.beforeOpen).toHaveBeenCalledTimes(1);
      expect(callbacks.onSaved).not.toHaveBeenCalled();
      expect(
        worker.sent.some((request) => request.op === "call" && request.method === "doc.mark-saved"),
      ).toBe(false);
    },
  );

  it("cancels sidecar export without calling the kernel or writing", async () => {
    const worker = new DocumentWorker();
    const client = new KernelClient(worker);
    const callbacks = options();
    const { result } = renderHook(() => useDocument(client, callbacks));
    await act(async () => result.current.openFile(file()));
    vi.mocked(chooseSaveTarget).mockResolvedValue(undefined);
    await act(async () => result.current.exportTimeline("csv"));
    expect(
      worker.sent.some((request) => request.op === "call" && request.method === "timeline.export"),
    ).toBe(false);
    expect(result.current.busy).toBe(false);
    expect(callbacks.onSaved).not.toHaveBeenCalled();
    expect(callbacks.reportError).not.toHaveBeenCalled();
  });

  it.each(["kernel", "write"])(
    "reports %s sidecar failures without changing the save point",
    async (failure) => {
      const worker = new DocumentWorker();
      const client = new KernelClient(worker);
      const callbacks = options();
      const write = vi.fn().mockResolvedValue(undefined);
      vi.mocked(chooseSaveTarget).mockResolvedValue({ write });
      const { result } = renderHook(() => useDocument(client, callbacks));
      await act(async () => result.current.openFile(file()));
      if (failure === "kernel") worker.rejectExport = true;
      else write.mockRejectedValue(new Error("disk full"));
      await act(async () => result.current.exportTimeline("labels"));
      if (failure === "kernel") expect(write).not.toHaveBeenCalled();
      expect(callbacks.reportError).toHaveBeenCalledWith(
        "Could not export markers and regions",
        expect.any(Error),
      );
      expect(callbacks.onSaved).not.toHaveBeenCalled();
      expect(result.current.busy).toBe(false);
    },
  );

  it("does not write a stale sidecar result after client replacement", async () => {
    const oldWorker = new DocumentWorker();
    const oldClient = new KernelClient(oldWorker);
    const callbacks = options();
    const choosing = deferred<Awaited<ReturnType<typeof chooseSaveTarget>>>();
    const write = vi.fn();
    vi.mocked(chooseSaveTarget).mockReturnValue(choosing.promise);
    const { result, rerender } = renderHook(({ client }) => useDocument(client, callbacks), {
      initialProps: { client: oldClient },
    });
    await act(async () => result.current.openFile(file()));
    act(() => result.current.exportTimeline("csv"));
    const replacement = new KernelClient(new DocumentWorker());
    rerender({ client: replacement });
    await act(async () => choosing.resolve({ write }));
    expect(write).not.toHaveBeenCalled();
    expect(
      oldWorker.sent.some(
        (request) => request.op === "call" && request.method === "timeline.export",
      ),
    ).toBe(false);
    expect(callbacks.onSaved).not.toHaveBeenCalled();
  });

  it("marks only the exported history state saved after writing and holds the lock through acknowledgement", async () => {
    const worker = new DocumentWorker();
    worker.holdSave = true;
    const client = new KernelClient(worker);
    const callbacks = options();
    const writing = deferred<void>();
    const write = vi.fn(() => writing.promise);
    vi.mocked(chooseSaveTarget).mockResolvedValue({ write });
    const { result } = renderHook(() => useDocument(client, callbacks));
    await act(async () => result.current.openFile(file()));
    await act(async () => result.current.save());
    expect(write).toHaveBeenCalledWith(exported);
    expect(result.current.busy).toBe(true);
    expect(
      worker.sent.some((request) => request.op === "call" && request.method === "doc.mark-saved"),
    ).toBe(false);
    const ignored = file("ignored.wav");
    act(() => result.current.openFile(ignored));
    expect(ignored.arrayBuffer).not.toHaveBeenCalled();
    await act(async () => writing.resolve(undefined));
    const acknowledgement = worker.sent.find(
      (request) => request.op === "call" && request.method === "doc.mark-saved",
    );
    expect(acknowledgement).toMatchObject({
      params: { documentId: info.documentId, stateId: "state-2" },
    });
    expect(result.current.busy).toBe(true);
    expect(callbacks.onSaved).not.toHaveBeenCalled();
    if (!acknowledgement) throw new Error("missing saved-state acknowledgement");
    await act(async () =>
      worker.emit({ kind: "reply", id: acknowledgement.id, ok: true, result: cleanHistory }),
    );
    expect(callbacks.onSaved).toHaveBeenCalledExactlyOnceWith(cleanHistory);
    expect(result.current.busy).toBe(false);
  });

  it.each(["export", "write", "acknowledgement"] as const)(
    "does not publish a save point after %s failure",
    async (phase) => {
      const worker = new DocumentWorker();
      worker.rejectExport = phase === "export";
      worker.rejectSave = phase === "acknowledgement";
      const client = new KernelClient(worker);
      const callbacks = options();
      const write = vi.fn(async () => {
        if (phase === "write") throw new Error("write failed");
      });
      vi.mocked(chooseSaveTarget).mockResolvedValue({ write });
      const { result } = renderHook(() => useDocument(client, callbacks));
      await act(async () => result.current.openFile(file()));
      await act(async () => result.current.save());
      expect(callbacks.onSaved).not.toHaveBeenCalled();
      expect(callbacks.reportError).toHaveBeenCalledWith("Could not save audio", expect.any(Error));
      expect(result.current.busy).toBe(false);
      if (phase !== "acknowledgement")
        expect(
          worker.sent.some(
            (request) => request.op === "call" && request.method === "doc.mark-saved",
          ),
        ).toBe(false);
    },
  );

  it("does not acknowledge a successful late write after unmount", async () => {
    const worker = new DocumentWorker();
    const client = new KernelClient(worker);
    const callbacks = options();
    const writing = deferred<void>();
    vi.mocked(chooseSaveTarget).mockResolvedValue({ write: () => writing.promise });
    const { result, unmount } = renderHook(() => useDocument(client, callbacks));
    await act(async () => result.current.openFile(file()));
    await act(async () => result.current.save());
    unmount();
    await act(async () => writing.resolve(undefined));
    expect(
      worker.sent.some((request) => request.op === "call" && request.method === "doc.mark-saved"),
    ).toBe(false);
    expect(callbacks.onSaved).not.toHaveBeenCalled();
    expect(callbacks.reportError).not.toHaveBeenCalled();
  });

  it("does not apply an old client's saved reply or release a new client's import lock", async () => {
    const oldWorker = new DocumentWorker();
    oldWorker.holdSave = true;
    const oldClient = new KernelClient(oldWorker);
    const newWorker = new DocumentWorker();
    const newClient = new KernelClient(newWorker);
    const callbacks = options();
    vi.mocked(chooseSaveTarget).mockResolvedValue({ write: async () => {} });
    const { result, rerender } = renderHook(({ client }) => useDocument(client, callbacks), {
      initialProps: { client: oldClient },
    });
    await act(async () => result.current.openFile(file()));
    await act(async () => result.current.save());
    const acknowledgement = oldWorker.sent.find(
      (request) => request.op === "call" && request.method === "doc.mark-saved",
    );
    if (!acknowledgement) throw new Error("missing saved-state acknowledgement");
    rerender({ client: newClient });
    const reading = deferred<ArrayBuffer>();
    await act(async () => result.current.openFile(file("new.wav", () => reading.promise)));
    await act(async () =>
      oldWorker.emit({ kind: "reply", id: acknowledgement.id, ok: true, result: cleanHistory }),
    );
    expect(callbacks.onSaved).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(true);
    await act(async () => reading.resolve(wavBytes(4)));
    expect(result.current.info?.name).toBe("new.wav");
    expect(result.current.busy).toBe(false);
  });

  it("does not export when the user cancels saving", async () => {
    const worker = new DocumentWorker();
    const client = new KernelClient(worker);
    vi.mocked(chooseSaveTarget).mockResolvedValue(undefined);
    const { result } = renderHook(() => useDocument(client, options()));
    await act(async () => result.current.openFile(file()));
    await act(async () => result.current.save());
    expect(
      worker.sent.filter((request) => request.op === "call" && request.method === "doc.export"),
    ).toHaveLength(0);
    expect(result.current.busy).toBe(false);
    expect(
      worker.sent.some((request) => request.op === "call" && request.method === "doc.mark-saved"),
    ).toBe(false);
  });

  it("does not continue importing after unmount", async () => {
    const worker = new DocumentWorker();
    const client = new KernelClient(worker);
    const callbacks = options();
    let finishStop: (() => void) | undefined;
    callbacks.beforeOpen.mockReturnValue(
      new Promise<void>((resolve) => {
        finishStop = resolve;
      }),
    );
    const { result, unmount } = renderHook(() => useDocument(client, callbacks));
    act(() => result.current.openFile(file()));
    unmount();
    await act(async () => finishStop?.());
    expect(
      worker.sent.filter((request) => request.op === "call" && request.method === "doc.open"),
    ).toHaveLength(0);
  });

  it("does not send a stale import to a replaced kernel client", async () => {
    const oldWorker = new DocumentWorker();
    const oldClient = new KernelClient(oldWorker);
    const newClient = new KernelClient(new DocumentWorker());
    const callbacks = options();
    let finishStop: (() => void) | undefined;
    callbacks.beforeOpen.mockReturnValue(
      new Promise<void>((resolve) => {
        finishStop = resolve;
      }),
    );
    const { result, rerender } = renderHook(({ client }) => useDocument(client, callbacks), {
      initialProps: { client: oldClient },
    });
    act(() => result.current.openFile(file()));
    rerender({ client: newClient });
    await act(async () => finishStop?.());
    expect(result.current.info).toBeUndefined();
    expect(result.current.busy).toBe(false);
    expect(
      oldWorker.sent.filter((request) => request.op === "call" && request.method === "doc.open"),
    ).toHaveLength(0);
  });

  it("does not let a late initial info response replace a freshly opened document", async () => {
    const worker = new DocumentWorker();
    worker.holdInfo = true;
    const client = new KernelClient(worker);
    const { result } = renderHook(() => useDocument(client, options()));
    await act(async () => result.current.openFile(file("new.wav")));
    await act(async () =>
      worker.emit({
        kind: "reply",
        id: worker.sent[0].id,
        ok: true,
        result: { ...info, name: "old.wav" },
      }),
    );
    expect(result.current.info?.name).toBe("new.wav");
  });

  it("opens a native picker selection through the same import path", async () => {
    const client = new KernelClient(new DocumentWorker());
    vi.mocked(chooseAudioFile).mockResolvedValue(file());
    const { result } = renderHook(() => useDocument(client, options()));
    await act(async () => result.current.open());
    expect(result.current.info).toEqual(info);
  });
});
