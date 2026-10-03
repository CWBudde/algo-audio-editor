import type { DocumentInfoResult, EditResult, HistoryListResult } from "@aae/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelClient, type WorkerLike } from "@/kernel/client";
import type { WorkerReply, WorkerRequest } from "@/kernel/messages";
import { type HistoryOptions, useHistory } from "./use-history";

const info: DocumentInfoResult = {
  documentId: "doc-1",
  name: "a.wav",
  sampleRate: 48000,
  channels: 2,
  frames: 1000,
  bitDepth: 16,
  float: false,
};
const history: HistoryListResult = {
  documentId: "doc-1",
  currentStateId: "state-2",
  savedStateId: "state-0",
  dirty: true,
  canUndo: true,
  canRedo: true,
  maxEntries: 100,
  maxBytes: 1024 * 1024,
  retainedBytes: 4096,
  entries: [
    { stateId: "state-0", label: "Opened document" },
    { stateId: "state-1", label: "Cut" },
    { stateId: "state-2", label: "Mute" },
    { stateId: "state-3", label: "Duplicate" },
  ],
};
const navigated: EditResult = {
  document: { ...info, documentId: "doc-2" },
  selection: { documentId: "doc-2", start: 100, end: 200, channelMask: 2 },
  timeline: { documentId: "doc-2", markers: [], regions: [] },
  clipboard: { version: "", available: false, sampleRate: 0, channels: 0, frames: 0 },
  changed: true,
  history: { ...history, documentId: "doc-2", currentStateId: "state-1" },
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
function mounted(overrides: Partial<HistoryOptions> = {}, strict = false) {
  const worker = new DeferredWorker();
  const options: HistoryOptions = {
    client: new KernelClient(worker),
    info,
    beforeEdit: vi.fn(async () => {}),
    onEdited: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
  return {
    worker,
    options,
    ...renderHook((props: HistoryOptions) => useHistory(props), {
      initialProps: options,
      wrapper: strict ? StrictMode : undefined,
    }),
  };
}
function seed(result: ReturnType<typeof mounted>["result"], value = history) {
  act(() => result.current.accept(value));
}
function start(
  result: ReturnType<typeof mounted>["result"],
  kind: "undo" | "redo" | "jump",
  stateId = "state-0",
) {
  let pending!: Promise<void>;
  act(() => {
    pending = kind === "jump" ? result.current.jump(stateId) : result.current[kind]();
  });
  return pending;
}
async function flush() {
  await act(async () => {});
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useHistory", () => {
  it("is safe before the kernel client is available", async () => {
    const { worker, result, options } = mounted({ client: undefined });
    expect(result.current.history).toBeUndefined();
    seed(result);
    await result.current.undo();
    expect(worker.sent).toHaveLength(0);
    expect(options.beforeEdit).not.toHaveBeenCalled();
  });
  it("loads authoritative history and reports current initialization failure", async () => {
    const { worker, result } = mounted();
    expect(result.current.history).toBeUndefined();
    expect(worker.calls("history.list")[0]).toMatchObject({ params: { documentId: "doc-1" } });
    await act(async () => worker.reply(worker.calls("history.list")[0], history));
    expect(result.current.history).toEqual(history);
    const failed = mounted();
    await act(async () => failed.worker.fail(failed.worker.calls("history.list")[0]));
    expect(failed.options.onError).toHaveBeenCalledWith(
      "Could not read edit history",
      expect.any(Error),
    );
  });

  it.each(["reply", "failure"])(
    "does not let stale initial %s overwrite an accepted edit/save snapshot",
    async (kind) => {
      const { worker, result, options } = mounted();
      const saved = { ...history, dirty: false, savedStateId: history.currentStateId };
      seed(result, saved);
      await act(async () => {
        if (kind === "reply") worker.reply(worker.calls("history.list")[0], history);
        else worker.fail(worker.calls("history.list")[0]);
      });
      expect(result.current.history).toEqual(saved);
      expect(options.onError).not.toHaveBeenCalled();
    },
  );

  it("accepts a new edit identity before batched document info updates", async () => {
    const { result, rerender, options, worker } = mounted();
    seed(result, navigated.history);
    expect(result.current.history).toBeUndefined();
    rerender({ ...options, info: navigated.document });
    expect(result.current.history).toEqual(navigated.history);
    await act(async () => worker.reply(worker.calls("history.list")[0], history));
    expect(result.current.history).toEqual(navigated.history);
    seed(result, navigated.history);
    await act(async () => worker.reply(worker.calls("history.list")[1], navigated.history));
    expect(result.current.history).toEqual(navigated.history);
  });

  it.each(["undo", "redo", "jump"] as const)(
    "serializes %s through playback stop, shared lock and explicit-ID RPC",
    async (kind) => {
      const stopping = deferred<void>();
      const order: string[] = [];
      const { worker, result, rerender, options } = mounted({
        beforeEdit: vi.fn(() => stopping.promise),
        withOperation: async (work) => {
          order.push("lock");
          await work();
          order.push("unlock");
        },
      });
      seed(result);
      const pending = start(result, kind);
      rerender({ ...options, busy: true });
      expect(result.current.busy).toBe(true);
      await result.current.undo();
      expect(options.beforeEdit).toHaveBeenCalledOnce();
      const method = kind === "jump" ? "history.jump" : `edit.${kind}`;
      expect(worker.calls(method)).toHaveLength(0);
      await act(async () => stopping.resolve());
      expect(worker.calls(method)[0]).toMatchObject({
        params: { documentId: "doc-1", ...(kind === "jump" ? { stateId: "state-0" } : {}) },
      });
      expect(order).toEqual(["lock"]);
      await result.current.redo();
      await act(async () => worker.reply(worker.calls(method)[0], navigated));
      await pending;
      expect(options.onEdited).toHaveBeenCalledExactlyOnceWith(navigated, "doc-1");
      expect(order).toEqual(["lock", "unlock"]);
      rerender({ ...options, info: navigated.document });
      expect(result.current.history).toEqual(navigated.history);
      expect(result.current.busy).toBe(false);
    },
  );

  it("does not stop for disabled undo/redo, current/unknown jumps, or missing history", async () => {
    const { worker, result, options } = mounted();
    await result.current.undo();
    await result.current.jump("state-0");
    seed(result, { ...history, canUndo: false, canRedo: false });
    await result.current.undo();
    await result.current.redo();
    await result.current.jump(history.currentStateId);
    await result.current.jump("missing");
    expect(options.beforeEdit).not.toHaveBeenCalled();
    expect(worker.sent).toHaveLength(1);
  });

  it("does not navigate while imports/edits are busy or without a loaded document", async () => {
    const { result, rerender, options } = mounted({ busy: true });
    seed(result);
    await result.current.undo();
    rerender({ ...options, busy: false, info: undefined });
    await result.current.redo();
    expect(options.beforeEdit).not.toHaveBeenCalled();
  });

  it("keeps the physical lock across document replacement until pending stop settles", async () => {
    const stopping = deferred<void>();
    const { result, options, rerender, worker } = mounted({ beforeEdit: () => stopping.promise });
    seed(result);
    const pending = start(result, "undo");
    rerender({ ...options, info: navigated.document });
    seed(result, navigated.history);
    await result.current.redo();
    expect(result.current.busy).toBe(true);
    await act(async () => stopping.resolve());
    await pending;
    expect(worker.calls("edit.undo")).toHaveLength(0);
    expect(options.onEdited).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
  });

  it("hides an old client's history and ignores its late navigation and GET replies", async () => {
    const { worker, result, options, rerender } = mounted();
    seed(result);
    const pending = start(result, "undo");
    await flush();
    const nextWorker = new DeferredWorker();
    rerender({ ...options, client: new KernelClient(nextWorker) });
    expect(result.current.history).toBeUndefined();
    await act(async () => {
      worker.reply(worker.calls("edit.undo")[0], navigated);
      worker.reply(worker.calls("history.list")[0], history);
    });
    await pending;
    expect(options.onEdited).not.toHaveBeenCalled();
    expect(result.current.history).toBeUndefined();
    await act(async () => nextWorker.reply(nextWorker.calls("history.list")[0], history));
    expect(result.current.history).toEqual(history);
  });

  it.each(["stop", "navigation"])(
    "reports %s rejection, preserves history, and releases the lock",
    async (kind) => {
      const { worker, result, options, rerender } = mounted({
        beforeEdit:
          kind === "stop"
            ? vi.fn(async () => {
                throw new Error("stop rejected");
              })
            : vi.fn(async () => {}),
      });
      seed(result);
      const pending = start(result, "undo");
      await flush();
      if (kind === "navigation") await act(async () => worker.fail(worker.calls("edit.undo")[0]));
      await pending;
      expect(result.current.history).toEqual(history);
      expect(options.onError).toHaveBeenCalledOnce();
      expect(options.onEdited).not.toHaveBeenCalled();
      expect(result.current.busy).toBe(false);
      rerender({ ...options, beforeEdit: async () => {} });
      const recovery = start(result, "redo");
      await flush();
      await act(async () => worker.reply(worker.calls("edit.redo")[0], navigated));
      await recovery;
      expect(options.onEdited).toHaveBeenCalledOnce();
    },
  );

  it("does not stop when the shared lock rejects acquisition", async () => {
    const { result, options } = mounted({
      withOperation: async () => {
        throw new Error("busy");
      },
    });
    seed(result);
    await act(async () => result.current.undo());
    expect(options.beforeEdit).not.toHaveBeenCalled();
    expect(options.onError).toHaveBeenCalledWith(
      "Could not undo edit history",
      expect.objectContaining({ message: "busy" }),
    );
    expect(result.current.busy).toBe(false);
  });

  it.each(["stop", "navigation"])(
    "does not mutate or report obsolete errors after unmount during %s",
    async (kind) => {
      const stopping = deferred<void>();
      const { worker, result, options, unmount } = mounted({
        beforeEdit: kind === "stop" ? () => stopping.promise : async () => {},
      });
      seed(result);
      const pending = start(result, "undo");
      await flush();
      unmount();
      if (kind === "stop") await act(async () => stopping.reject(new Error("old failure")));
      else await act(async () => worker.fail(worker.calls("edit.undo")[0]));
      await pending;
      expect(options.onError).not.toHaveBeenCalled();
      expect(options.onEdited).not.toHaveBeenCalled();
    },
  );

  it("ignores stale StrictMode GET replies and invalid response identities", async () => {
    const { worker, result } = mounted({}, true);
    const gets = worker.calls("history.list");
    expect(gets).toHaveLength(2);
    await act(async () => worker.reply(gets[0], history));
    expect(result.current.history).toBeUndefined();
    await act(async () => worker.reply(gets[1], navigated.history));
    expect(result.current.history).toBeUndefined();
  });
});
