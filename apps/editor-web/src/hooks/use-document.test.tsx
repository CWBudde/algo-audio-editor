import type { DocumentInfoResult, ExportResult } from "@aae/protocol";
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

class DocumentWorker implements WorkerLike {
  sent: WorkerRequest[] = [];
  private listener?: (event: MessageEvent<WorkerReply>) => void;
  rejectOpen = false;
  holdInfo = false;
  postMessage(request: WorkerRequest) {
    this.sent.push(request);
    if (request.op !== "call") return;
    if (request.method === "doc.info" && this.holdInfo) return;
    const reply: WorkerReply =
      request.method === "doc.info" || this.rejectOpen
        ? { kind: "reply", id: request.id, ok: false, error: "invalid document" }
        : {
            kind: "reply",
            id: request.id,
            ok: true,
            result:
              request.method === "doc.export"
                ? exported
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

function file(name = info.name, read = () => Promise.resolve(new ArrayBuffer(4))) {
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
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useDocument", () => {
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
    const bytes = new ArrayBuffer(8);
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
    await act(async () => reading.resolve(new ArrayBuffer(4)));
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
    await act(async () => newReading.resolve(new ArrayBuffer(4)));
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
    await act(async () => reading.resolve(new ArrayBuffer(4)));
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
    expect(chooseSaveTarget).toHaveBeenCalledWith(info.name);
    expect(
      worker.sent.find((request) => request.op === "call" && request.method === "doc.export"),
    ).toMatchObject({ params: { format: "wav", bitDepth: 24, float: false } });
    expect(write).toHaveBeenCalledWith(exported);
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
