import type {
  ClipboardInfo,
  DocumentInfoResult,
  EditResult,
  PastePlan,
  SelectionRange,
} from "@aae/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelClient, type WorkerLike } from "@/kernel/client";
import type { WorkerReply, WorkerRequest } from "@/kernel/messages";
import { type EditOptions, useEdit } from "./use-edit";

const info: DocumentInfoResult = {
  documentId: "doc-1",
  name: "a.wav",
  sampleRate: 48000,
  channels: 2,
  frames: 1000,
  bitDepth: 16,
  float: false,
};
const selection: SelectionRange = { start: 100, end: 200, channelMask: 3 };
const empty: ClipboardInfo = {
  version: "0",
  available: false,
  sampleRate: 0,
  channels: 0,
  frames: 0,
};
const copied: ClipboardInfo = {
  version: "1",
  available: true,
  sampleRate: 44100,
  channels: 1,
  frames: 100,
};
const plan: PastePlan = {
  conversionRequired: true,
  sourceRate: 44100,
  targetRate: 48000,
  sourceChannels: 1,
  targetChannels: 2,
  frames: 109,
  clipboardVersion: "1",
};
const edited: EditResult = {
  document: { ...info, documentId: "doc-2", frames: 900 },
  selection: { ...selection, documentId: "doc-2" },
  timeline: { documentId: "doc-2", markers: [], regions: [] },
  clipboard: copied,
  changed: true,
  history: {
    documentId: "doc-2",
    currentStateId: "state-2",
    savedStateId: "state-1",
    dirty: true,
    canUndo: true,
    canRedo: false,
    entries: [
      { stateId: "state-1", label: "Opened document" },
      { stateId: "state-2", label: "Cut" },
    ],
    maxEntries: 100,
    maxBytes: 512 << 20,
    retainedBytes: 0,
  },
};

class DeferredWorker implements WorkerLike {
  sent: WorkerRequest[] = [];
  private listener?: (event: MessageEvent<WorkerReply>) => void;
  postMessage(request: WorkerRequest) {
    this.sent.push(request);
  }
  addEventListener(_type: "message", listener: (event: MessageEvent<WorkerReply>) => void) {
    this.listener = listener;
  }
  terminate() {}
  calls(method: string) {
    return this.sent.filter((request) => request.op === "call" && request.method === method);
  }
  last(method: string) {
    const request = this.calls(method).at(-1);
    if (!request) throw new Error(`No ${method} request`);
    return request;
  }
  reply(request: WorkerRequest, result: unknown) {
    this.listener?.({
      data: { kind: "reply", id: request.id, ok: true, result },
    } as MessageEvent<WorkerReply>);
  }
  fail(request: WorkerRequest) {
    this.listener?.({
      data: { kind: "reply", id: request.id, ok: false, error: "rejected" },
    } as MessageEvent<WorkerReply>);
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function mounted(overrides: Partial<EditOptions> = {}) {
  const worker = new DeferredWorker();
  const options: EditOptions = {
    client: new KernelClient(worker),
    info,
    beforeEdit: vi.fn(async () => {}),
    onEdited: vi.fn(),
    onRecorded: vi.fn(),
    confirmConversion: vi.fn(async () => true),
    onError: vi.fn(),
    ...overrides,
  };
  return {
    worker,
    options,
    ...renderHook((props: EditOptions) => useEdit(props), { initialProps: options }),
  };
}
async function flush() {
  await act(async () => {});
}
function start(
  result: ReturnType<typeof mounted>["result"],
  operation: Parameters<ReturnType<typeof useEdit>["run"]>[0],
  frames?: number,
) {
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.run(operation, selection, frames);
  });
  return pending;
}
async function prepare(worker: DeferredWorker, required = true) {
  await act(async () => worker.reply(worker.last("edit.state"), copied));
  await act(async () =>
    worker.reply(worker.last("edit.prepare-paste"), {
      ...plan,
      conversionRequired: required,
    }),
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useEdit", () => {
  it("loads clipboard state and ignores initialization older than successful copy", async () => {
    const { worker, result, options } = mounted();
    const initial = worker.calls("edit.state")[0];
    const pending = start(result, "copy");
    expect(options.beforeEdit).not.toHaveBeenCalled();
    await act(async () =>
      worker.reply(worker.calls("edit.apply")[0], { ...edited, changed: false, document: info }),
    );
    await pending;
    await act(async () => worker.reply(initial, empty));
    expect(result.current.clipboard).toEqual(copied);
    expect(options.onEdited).toHaveBeenCalledWith(
      expect.objectContaining({ changed: false }),
      "doc-1",
    );
    expect(result.current.busy).toBe(false);
  });

  it("serializes physically through playback stop and apply, snapshots the selected range", async () => {
    const stopping = deferred<void>();
    const { worker, result, options } = mounted({ beforeEdit: vi.fn(() => stopping.promise) });
    const mutable = { ...selection };
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.run("cut", mutable);
    });
    mutable.start = 999;
    await result.current.run("delete", selection);
    expect(result.current.busy).toBe(true);
    expect(worker.calls("edit.apply")).toHaveLength(0);
    await act(async () => stopping.resolve());
    expect(worker.calls("edit.apply")).toHaveLength(1);
    expect(worker.calls("edit.apply")[0]).toMatchObject({
      params: { documentId: "doc-1", ...selection, operation: "cut" },
    });
    await result.current.run("copy", selection);
    expect(worker.calls("edit.apply")).toHaveLength(1);
    await act(async () => worker.reply(worker.calls("edit.apply")[0], edited));
    await pending;
    expect(options.beforeEdit).toHaveBeenCalledOnce();
    expect(options.onEdited).toHaveBeenCalledWith(edited, "doc-1");
  });

  it("rejects document/import busy and missing-document actions without RPC or stopping", async () => {
    const { worker, result, rerender, options } = mounted({ busy: true });
    await result.current.run("delete", selection);
    rerender({ ...options, busy: false, info: undefined });
    await result.current.run("copy", selection);
    expect(worker.calls("edit.apply")).toHaveLength(0);
    expect(options.beforeEdit).not.toHaveBeenCalled();
  });

  it("holds the shared workflow through prepare, confirmation and apply without invalidating itself on busy", async () => {
    const confirming = deferred<boolean>();
    const order: string[] = [];
    const { worker, result, rerender, options } = mounted({
      confirmConversion: vi.fn(() => confirming.promise),
      withOperation: async (work) => {
        order.push("lock");
        await work();
        order.push("unlock");
      },
    });
    const pending = start(result, "paste-insert");
    rerender({ ...options, busy: true });
    await prepare(worker);
    expect(options.beforeEdit).not.toHaveBeenCalled();
    expect(options.confirmConversion).toHaveBeenCalledWith(plan);
    expect(order).toEqual(["lock"]);
    await act(async () => confirming.resolve(true));
    expect(options.beforeEdit).toHaveBeenCalledOnce();
    expect(worker.calls("edit.apply")[0]).toMatchObject({
      params: {
        documentId: "doc-1",
        ...selection,
        operation: "paste-insert",
        convert: true,
        clipboardVersion: "1",
      },
    });
    await act(async () => worker.reply(worker.calls("edit.apply")[0], edited));
    await pending;
    expect(order).toEqual(["lock", "unlock"]);
  });

  it.each(["paste-replace", "paste-mix"] as const)(
    "applies %s without asking when conversion is unnecessary",
    async (operation) => {
      const { worker, result, options } = mounted();
      const pending = start(result, operation);
      await prepare(worker, false);
      expect(options.confirmConversion).not.toHaveBeenCalled();
      expect(worker.calls("edit.apply")[0]).toMatchObject({
        params: { operation, clipboardVersion: "1" },
      });
      expect(worker.calls("edit.apply")[0]).not.toHaveProperty("params.convert");
      await act(async () => worker.reply(worker.calls("edit.apply")[0], edited));
      await pending;
    },
  );

  it.each([false, "reject"])(
    "does not stop or apply on canceled/rejected confirmation (%s)",
    async (answer) => {
      const { worker, result, options } = mounted({
        confirmConversion: vi.fn(async () => {
          if (answer === "reject") throw new Error("dialog unavailable");
          return false;
        }),
      });
      const pending = start(result, "paste-insert");
      await prepare(worker);
      await pending;
      expect(options.beforeEdit).not.toHaveBeenCalled();
      expect(worker.calls("edit.apply")).toHaveLength(0);
      expect(result.current.busy).toBe(false);
      expect(options.onError).toHaveBeenCalledTimes(answer === false ? 0 : 1);
    },
  );

  it("checks the real clipboard state and does not prepare or stop for an empty clipboard", async () => {
    const { worker, result, options } = mounted();
    const pending = start(result, "paste-insert");
    await act(async () => worker.reply(worker.last("edit.state"), empty));
    await pending;
    expect(worker.calls("edit.prepare-paste")).toHaveLength(0);
    expect(options.beforeEdit).not.toHaveBeenCalled();
  });

  it("reports preparation failure without stopping and releases a rejected shared lock", async () => {
    const { worker, result, options, rerender } = mounted();
    const pending = start(result, "paste-insert");
    await act(async () => worker.reply(worker.last("edit.state"), copied));
    await act(async () => worker.fail(worker.calls("edit.prepare-paste")[0]));
    await pending;
    expect(options.beforeEdit).not.toHaveBeenCalled();
    expect(options.onError).toHaveBeenCalledWith("Could not paste-insert", expect.any(Error));
    rerender({
      ...options,
      withOperation: async () => {
        throw new Error("busy");
      },
    });
    await act(async () => result.current.run("delete", selection));
    expect(options.onError).toHaveBeenLastCalledWith(
      "Could not delete",
      expect.objectContaining({ message: "busy" }),
    );
    expect(result.current.busy).toBe(false);
  });

  it("retains the physical lock after replacement until a pending stop settles", async () => {
    const stopping = deferred<void>();
    const { worker, result, options, rerender } = mounted({ beforeEdit: () => stopping.promise });
    const pending = start(result, "delete");
    rerender({ ...options, info: { ...info, documentId: "doc-3" } });
    await result.current.run("copy", selection);
    expect(result.current.busy).toBe(true);
    await act(async () => stopping.resolve());
    await pending;
    expect(worker.calls("edit.apply")).toHaveLength(0);
    expect(options.onEdited).not.toHaveBeenCalled();
    expect(options.onRecorded).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
  });

  it("cancels an unresolved confirmation on replacement and ignores its eventual acceptance", async () => {
    const confirming = deferred<boolean>();
    const { worker, result, options, rerender } = mounted({
      confirmConversion: () => confirming.promise,
    });
    const pending = start(result, "paste-insert");
    await prepare(worker);
    rerender({ ...options, info: { ...info, documentId: "doc-3" } });
    await act(async () => {
      await pending;
    });
    await act(async () => confirming.resolve(true));
    expect(options.beforeEdit).not.toHaveBeenCalled();
    expect(worker.calls("edit.apply")).toHaveLength(0);
    expect(result.current.busy).toBe(false);
  });

  it("keeps the lock while obsolete apply settles and ignores old-client results/state", async () => {
    const { worker, result, options, rerender } = mounted();
    const pending = start(result, "delete");
    await flush();
    const next = new DeferredWorker();
    rerender({ ...options, client: new KernelClient(next) });
    expect(result.current.clipboard).toBeUndefined();
    await result.current.run("copy", selection);
    expect(next.calls("edit.apply")).toHaveLength(0);
    await act(async () => {
      worker.reply(worker.calls("edit.apply")[0], edited);
      worker.reply(worker.calls("edit.state")[0], copied);
    });
    await pending;
    expect(options.onEdited).not.toHaveBeenCalled();
    expect(options.onRecorded).not.toHaveBeenCalled();
    expect(result.current.clipboard).toBeUndefined();
    await act(async () => next.reply(next.calls("edit.state")[0], empty));
    expect(result.current.clipboard).toEqual(empty);
  });

  it("does not mutate after unmount during a pending prepare or stop", async () => {
    const { worker, result, options, unmount } = mounted();
    const pending = start(result, "paste-insert");
    await act(async () => worker.reply(worker.last("edit.state"), copied));
    unmount();
    await act(async () => worker.reply(worker.calls("edit.prepare-paste")[0], plan));
    await pending;
    expect(options.beforeEdit).not.toHaveBeenCalled();
    expect(options.confirmConversion).not.toHaveBeenCalled();
    expect(worker.calls("edit.apply")).toHaveLength(0);
  });

  it("passes exact silence frames and reports a rejected apply without announcing edits", async () => {
    const { worker, result, options } = mounted();
    const pending = start(result, "insert-silence", 1 << 30);
    await flush();
    expect(worker.calls("edit.apply")[0]).toMatchObject({ params: { frames: 1073741824 } });
    await act(async () => worker.fail(worker.calls("edit.apply")[0]));
    await pending;
    expect(options.onEdited).not.toHaveBeenCalled();
    expect(options.onRecorded).not.toHaveBeenCalled();
    expect(options.onError).toHaveBeenCalledWith("Could not insert-silence", expect.any(Error));
  });

  it("waits for a rejected stop, reports it once, and allows a later operation", async () => {
    const stopping = deferred<void>();
    const { worker, result, options, rerender } = mounted({ beforeEdit: () => stopping.promise });
    const pending = start(result, "delete");
    await act(async () => stopping.reject(new Error("stop failed")));
    await pending;
    expect(worker.calls("edit.apply")).toHaveLength(0);
    expect(options.onError).toHaveBeenCalledExactlyOnceWith(
      "Could not delete",
      expect.objectContaining({ message: "stop failed" }),
    );
    expect(result.current.busy).toBe(false);
    rerender({ ...options, beforeEdit: async () => {} });
    const next = start(result, "copy");
    await act(async () =>
      worker.reply(worker.calls("edit.apply")[0], { ...edited, changed: false }),
    );
    await next;
    expect(options.onEdited).toHaveBeenCalledOnce();
    expect(options.onRecorded).toHaveBeenCalledOnce();
  });

  it("does not apply or report a late failure after unmount during stop", async () => {
    const stopping = deferred<void>();
    const { worker, result, options, unmount } = mounted({ beforeEdit: () => stopping.promise });
    const pending = start(result, "delete");
    unmount();
    await act(async () => stopping.reject(new Error("old stop failed")));
    await pending;
    expect(worker.calls("edit.apply")).toHaveLength(0);
    expect(options.onError).not.toHaveBeenCalled();
    expect(options.onEdited).not.toHaveBeenCalled();
    expect(options.onRecorded).not.toHaveBeenCalled();
  });

  it("releases pending confirmation on unmount without waiting for the dialog owner", async () => {
    const confirming = deferred<boolean>();
    const { worker, result, options, unmount } = mounted({
      confirmConversion: () => confirming.promise,
    });
    const pending = start(result, "paste-insert");
    await prepare(worker);
    unmount();
    await pending;
    await act(async () => confirming.reject(new Error("obsolete dialog")));
    expect(options.beforeEdit).not.toHaveBeenCalled();
    expect(options.onError).not.toHaveBeenCalled();
    expect(worker.calls("edit.apply")).toHaveLength(0);
  });

  it("reports current clipboard initialization errors but not obsolete failures after copy", async () => {
    const { worker, result, options } = mounted();
    const initial = worker.calls("edit.state")[0];
    const pending = start(result, "copy");
    await act(async () =>
      worker.reply(worker.calls("edit.apply")[0], { ...edited, changed: false }),
    );
    await pending;
    await act(async () => worker.fail(initial));
    expect(options.onError).not.toHaveBeenCalled();
    const fresh = mounted();
    await act(async () => fresh.worker.fail(fresh.worker.calls("edit.state")[0]));
    expect(fresh.options.onError).toHaveBeenCalledWith(
      "Could not read clipboard",
      expect.any(Error),
    );
  });
});
