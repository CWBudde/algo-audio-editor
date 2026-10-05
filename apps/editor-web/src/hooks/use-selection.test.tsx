import type {
  DocumentInfoResult,
  EditResult,
  HistoryListResult,
  SelectionResult,
  TimelineResult,
} from "@aae/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelClient, type WorkerLike } from "@/kernel/client";
import type { WorkerReply, WorkerRequest } from "@/kernel/messages";
import { type SelectionOptions, useSelection } from "./use-selection";

const info: DocumentInfoResult = {
  documentId: "doc-1",
  name: "same.wav",
  sampleRate: 48000,
  channels: 2,
  frames: 48000,
  bitDepth: 16,
  float: false,
};
const initial: SelectionResult = { documentId: info.documentId, start: 0, end: 0, channelMask: 3 };
const timeline: TimelineResult = { documentId: info.documentId, markers: [], regions: [] };
const history: HistoryListResult = {
  documentId: info.documentId,
  currentStateId: "state-2",
  savedStateId: "state-1",
  dirty: true,
  canUndo: true,
  canRedo: false,
  entries: [
    { stateId: "state-1", label: "Opened" },
    { stateId: "state-2", label: "Timeline" },
  ],
  maxEntries: 100,
  maxBytes: 1000000,
  retainedBytes: 0,
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

type SelectionSeed = Pick<EditResult, "selection" | "timeline">;
interface HookProps {
  client: KernelClient;
  info: DocumentInfoResult;
  initial?: SelectionSeed;
  options?: SelectionOptions;
}

function mounted(strict = false, seed?: SelectionSeed, options?: SelectionOptions) {
  const worker = new DeferredWorker();
  const client = new KernelClient(worker);
  const initialProps: HookProps = { client, info, initial: seed, options };
  return {
    worker,
    client,
    ...renderHook(
      ({ client, info, initial, options }: HookProps) =>
        useSelection(client, info, initial, options),
      {
        initialProps,
        wrapper: strict ? StrictMode : undefined,
      },
    ),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useSelection", () => {
  it("checks live preview ownership before a rerender and expires it on commit or cancellation", () => {
    const { result } = mounted();
    const first = { start: 10, end: 20, channelMask: 1 };
    const second = { ...first };
    act(() => {
      result.current.preview(first);
      expect(result.current.getSelection()).toBe(first);
      expect(result.current.isPreview()).toBe(true);
      expect(result.current.isPreview(first)).toBe(true);
      expect(result.current.isPreview(second)).toBe(false);
      result.current.preview(second);
      expect(result.current.getSelection()).toBe(second);
      expect(result.current.isPreview(first)).toBe(false);
      expect(result.current.isPreview(second)).toBe(true);
      result.current.commit(second);
      expect(result.current.getSelection()).toBe(second);
      expect(result.current.isPreview()).toBe(false);
      expect(result.current.isPreview(second)).toBe(false);
      result.current.preview(first);
      result.current.cancelPreview();
      expect(result.current.getSelection()).toBe(second);
      expect(result.current.isPreview(first)).toBe(false);
    });
  });
  const seeded: SelectionSeed = {
    selection: { ...initial, start: 100, end: 200, channelMask: 2 },
    timeline: {
      ...timeline,
      markers: [{ id: 1, frame: 150, name: "Cue", color: "#a78bfa" }],
      regions: [{ id: 2, start: 100, end: 200, name: "Verse", color: "#a78bfa" }],
    },
  };

  it("immediately seeds edit selection, channel mask and anchors before delayed initial GET replies", async () => {
    const { worker, result } = mounted(false, seeded);
    expect(result.current.selection).toEqual({ start: 100, end: 200, channelMask: 2 });
    expect(result.current.timeline).toEqual(seeded.timeline);
    expect(result.current.previewing).toBe(false);
    expect(worker.calls("selection.get")).toHaveLength(1);
    expect(worker.calls("timeline.get")).toHaveLength(1);
    expect(worker.calls("selection.set")).toHaveLength(0);
    const readBack = { ...seeded.selection, start: 110, end: 210 };
    await act(async () => {
      worker.reply(worker.calls("selection.get")[0], readBack);
      worker.reply(worker.calls("timeline.get")[0], { ...seeded.timeline, markers: [] });
    });
    expect(result.current.selection).toEqual({ start: 110, end: 210, channelMask: 2 });
    expect(result.current.timeline.markers).toEqual([]);
  });

  it("rolls a rejected commit back to seeded acknowledgement while GET is still pending", async () => {
    const { worker, result } = mounted(false, seeded);
    act(() => result.current.commit({ start: 300, end: 400, channelMask: 1 }));
    await act(async () => worker.fail(worker.calls("selection.set")[0]));
    expect(result.current.selection).toEqual({ start: 100, end: 200, channelMask: 2 });
    expect(result.current.timeline).toEqual(seeded.timeline);
    expect(result.current.error).toBe("rejected");
    await act(async () => worker.reply(worker.calls("selection.get")[0], seeded.selection));
    expect(result.current.selection).toEqual({ start: 100, end: 200, channelMask: 2 });
  });

  it.each(["selection", "timeline", "both"] as const)(
    "ignores an old-document seed when %s identity mismatches",
    (part) => {
      const stale = {
        selection: {
          ...seeded.selection,
          documentId: part === "timeline" ? info.documentId : "doc-old",
        },
        timeline: {
          ...seeded.timeline,
          documentId: part === "selection" ? info.documentId : "doc-old",
        },
      };
      const { result } = mounted(false, stale);
      expect(result.current.selection).toEqual({ start: 0, end: 0, channelMask: 3 });
      expect(result.current.timeline).toEqual(timeline);
    },
  );

  it("retains local preview/commit revision guards with a seeded snapshot", async () => {
    const { worker, result } = mounted(false, seeded);
    const preview = { start: 300, end: 400, channelMask: 1 };
    act(() => result.current.preview(preview));
    await act(async () => worker.reply(worker.calls("selection.get")[0], seeded.selection));
    expect(result.current.selection).toEqual(preview);
    expect(result.current.previewing).toBe(true);
    act(() => result.current.cancelPreview());
    expect(result.current.selection).toEqual({ start: 100, end: 200, channelMask: 2 });
    act(() => result.current.commit(preview));
    await act(async () =>
      worker.reply(worker.calls("selection.set")[0], { ...seeded.selection, ...preview }),
    );
    expect(result.current.selection).toEqual(preview);
    expect(result.current.previewing).toBe(false);
  });

  it("updates the seed dependency and rejects old GET and StrictMode initialization replies", async () => {
    const { worker, result, client, rerender } = mounted(true, seeded);
    expect(result.current.selection).toEqual({ start: 100, end: 200, channelMask: 2 });
    const next = { ...seeded, selection: { ...seeded.selection, start: 500, end: 600 } };
    rerender({ client, info, initial: next });
    expect(result.current.selection).toEqual({ start: 500, end: 600, channelMask: 2 });
    const gets = worker.calls("selection.get");
    expect(gets).toHaveLength(3);
    await act(async () => {
      worker.reply(gets[1], seeded.selection);
      worker.reply(gets[0], initial);
    });
    expect(result.current.selection).toEqual({ start: 500, end: 600, channelMask: 2 });
    await act(async () => worker.reply(gets[2], next.selection));
    expect(result.current.selection).toEqual({ start: 500, end: 600, channelMask: 2 });
  });

  it("loads authoritative selection and real timeline anchors", async () => {
    const { worker, result } = mounted();
    expect(result.current.selection).toEqual({ start: 0, end: 0, channelMask: 3 });
    await act(async () => {
      worker.reply(worker.calls("selection.get")[0], {
        ...initial,
        start: 4,
        end: 10,
        channelMask: 2,
      });
      worker.reply(worker.calls("timeline.get")[0], {
        ...timeline,
        markers: [{ id: 1, frame: 7, name: "Cue", color: "#a78bfa" }],
      });
    });
    expect(result.current.selection).toEqual({ start: 4, end: 10, channelMask: 2 });
    expect(result.current.timeline.markers[0].frame).toBe(7);
  });

  it("does not overwrite local interaction with late initialization and retains only newest pending write", async () => {
    const { worker, result } = mounted();
    const a = { start: 5, end: 15, channelMask: 1 };
    const b = { start: 6, end: 16, channelMask: 2 };
    const c = { start: 7, end: 17, channelMask: 3 };
    act(() => {
      result.current.commit(a);
      result.current.commit(b);
      result.current.commit(c);
    });
    expect(worker.calls("selection.set")).toHaveLength(1);
    await act(async () => worker.reply(worker.calls("selection.get")[0], initial));
    expect(result.current.selection).toEqual(c);
    await act(async () => worker.reply(worker.calls("selection.set")[0], { ...initial, ...a }));
    expect(worker.calls("selection.set")).toHaveLength(2);
    expect(worker.calls("selection.set")[1]).toMatchObject({ params: { ...initial, ...c } });
    await act(async () => worker.reply(worker.calls("selection.set")[1], { ...initial, ...c }));
    expect(result.current.selection).toEqual(c);
  });

  it("rolls back a rejected current write to the acknowledged range and can recover", async () => {
    const { worker, result } = mounted();
    const acknowledged = { start: 10, end: 20, channelMask: 1 };
    await act(async () =>
      worker.reply(worker.calls("selection.get")[0], { ...initial, ...acknowledged }),
    );
    act(() => result.current.commit({ start: 15, end: 25, channelMask: 3 }));
    await act(async () => worker.fail(worker.calls("selection.set")[0]));
    expect(result.current.selection).toEqual(acknowledged);
    expect(result.current.error).toBe("rejected");
    act(() => result.current.commit({ start: 11, end: 21, channelMask: 2 }));
    await act(async () =>
      worker.reply(worker.calls("selection.set")[1], {
        ...initial,
        start: 11,
        end: 21,
        channelMask: 2,
      }),
    );
    expect(result.current.error).toBeUndefined();
  });

  it("does not roll back a newer preview when an earlier write fails", async () => {
    const { worker, result } = mounted();
    act(() => result.current.commit({ start: 3, end: 10, channelMask: 3 }));
    act(() => result.current.preview({ start: 7, end: 20, channelMask: 2 }));
    await act(async () => worker.fail(worker.calls("selection.set")[0]));
    expect(result.current.selection).toEqual({ start: 7, end: 20, channelMask: 2 });
    expect(result.current.error).toBe("rejected");
    act(() => result.current.cancelPreview());
    expect(result.current.selection).toEqual({ start: 0, end: 0, channelMask: 3 });
  });

  it("accepts authoritative initialization after a cancelled preview", async () => {
    const { worker, result } = mounted();
    act(() => result.current.preview({ start: 7, end: 20, channelMask: 2 }));
    act(() => result.current.cancelPreview());
    await act(async () =>
      worker.reply(worker.calls("selection.get")[0], {
        ...initial,
        start: 100,
        end: 200,
        channelMask: 1,
      }),
    );
    expect(result.current.selection).toEqual({ start: 100, end: 200, channelMask: 1 });
  });

  it("keeps an active preview but cancels to authoritative late initialization", async () => {
    const { worker, result } = mounted();
    act(() => result.current.preview({ start: 7, end: 20, channelMask: 2 }));
    await act(async () =>
      worker.reply(worker.calls("selection.get")[0], {
        ...initial,
        start: 100,
        end: 200,
        channelMask: 1,
      }),
    );
    expect(result.current.selection).toEqual({ start: 7, end: 20, channelMask: 2 });
    act(() => result.current.cancelPreview());
    expect(result.current.selection).toEqual({ start: 100, end: 200, channelMask: 1 });
  });

  it("does not display an obsolete snap error after a newer selection succeeds", async () => {
    const { worker, result } = mounted();
    const pending = result.current.snap(100, 25, 2);
    act(() => result.current.commit({ start: 20, end: 30, channelMask: 1 }));
    await act(async () =>
      worker.reply(worker.calls("selection.set")[0], {
        ...initial,
        start: 20,
        end: 30,
        channelMask: 1,
      }),
    );
    await act(async () => worker.fail(worker.calls("selection.snap")[0]));
    expect(await pending).toBeUndefined();
    expect(result.current.error).toBeUndefined();
  });

  it("restores late authoritative initialization after an early write is rejected", async () => {
    const { worker, result } = mounted();
    act(() => result.current.commit({ start: 7, end: 20, channelMask: 2 }));
    await act(async () => worker.fail(worker.calls("selection.set")[0]));
    await act(async () =>
      worker.reply(worker.calls("selection.get")[0], {
        ...initial,
        start: 100,
        end: 200,
        channelMask: 1,
      }),
    );
    expect(result.current.selection).toEqual({ start: 100, end: 200, channelMask: 1 });
  });

  it("does not lose late authoritative timeline initialization after a rejected add", async () => {
    const { worker, result } = mounted();
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.addAnchor("marker", "Cue");
    });
    await act(async () => worker.fail(worker.calls("markers.add")[0]));
    await pending;
    const existing = {
      ...timeline,
      markers: [{ id: 1, frame: 100, name: "Existing", color: "#a78bfa" }],
    };
    await act(async () => worker.reply(worker.calls("timeline.get")[0], existing));
    expect(result.current.timeline).toEqual(existing);
  });

  it("hides old state on identical-name reopen and discards its pending writes", async () => {
    const { worker, result, rerender, client } = mounted();
    act(() => {
      result.current.commit({ start: 3, end: 10, channelMask: 1 });
      result.current.commit({ start: 4, end: 11, channelMask: 1 });
    });
    const next = { ...info, documentId: "doc-2" };
    rerender({ client, info: next });
    expect(result.current.selection).toEqual({ start: 0, end: 0, channelMask: 3 });
    act(() => result.current.commit({ start: 30, end: 40, channelMask: 2 }));
    expect(worker.calls("selection.set")).toHaveLength(1);
    await act(async () => {
      worker.reply(worker.calls("selection.get")[0], { ...initial, start: 999, end: 999 });
      worker.reply(worker.calls("selection.set")[0], {
        ...initial,
        start: 3,
        end: 10,
        channelMask: 1,
      });
    });
    expect(result.current.selection).toEqual({ start: 30, end: 40, channelMask: 2 });
    expect(worker.calls("selection.set")[1]).toMatchObject({
      params: { documentId: "doc-2", start: 30, end: 40, channelMask: 2 },
    });
  });

  it("guards client replacement and unmount without draining obsolete writes", async () => {
    const { worker, result, rerender, unmount } = mounted();
    act(() => {
      result.current.commit({ start: 1, end: 2, channelMask: 3 });
      result.current.commit({ start: 2, end: 3, channelMask: 3 });
    });
    const nextWorker = new DeferredWorker();
    rerender({ client: new KernelClient(nextWorker), info });
    act(() => result.current.commit({ start: 5, end: 6, channelMask: 1 }));
    await act(async () => worker.reply(worker.calls("selection.set")[0], initial));
    expect(worker.calls("selection.set")).toHaveLength(1);
    expect(nextWorker.calls("selection.set")).toHaveLength(1);
    act(() => result.current.commit({ start: 6, end: 7, channelMask: 1 }));
    unmount();
    await act(async () => nextWorker.reply(nextWorker.calls("selection.set")[0], initial));
    expect(nextWorker.calls("selection.set")).toHaveLength(1);
  });

  it("rejects stale StrictMode initialization replies", async () => {
    const { worker, result } = mounted(true);
    const gets = worker.calls("selection.get");
    expect(gets).toHaveLength(2);
    await act(async () => worker.reply(gets[1], { ...initial, start: 5, end: 8 }));
    await act(async () => worker.reply(gets[0], { ...initial, start: 20, end: 30 }));
    expect(result.current.selection).toEqual({ start: 5, end: 8, channelMask: 3 });
  });

  it("gets bounded kernel snap results and drops a reply after document replacement", async () => {
    const { worker, result, rerender, client } = mounted();
    const pending = result.current.snap(100, 25, 2);
    expect(worker.calls("selection.snap")[0]).toMatchObject({
      params: { documentId: "doc-1", frame: 100, radius: 25, channelMask: 2 },
    });
    await act(async () =>
      worker.reply(worker.calls("selection.snap")[0], {
        documentId: "doc-1",
        frame: 103,
        found: true,
      }),
    );
    expect(await pending).toEqual({ documentId: "doc-1", frame: 103, found: true });
    const stale = result.current.snap(200, 25, 3);
    rerender({ client, info: { ...info, documentId: "doc-2" } });
    await act(async () =>
      worker.reply(worker.calls("selection.snap")[1], {
        documentId: "doc-1",
        frame: 201,
        found: true,
      }),
    );
    expect(await stale).toBeUndefined();
    const failed = result.current.snap(200, 25, 3);
    await act(async () => worker.fail(worker.calls("selection.snap")[2]));
    expect(await failed).toBeUndefined();
    expect(result.current.error).toBe("rejected");
  });

  it("serializes anchor creation, preserves added anchors over late initialization and hides obsolete replies", async () => {
    const { worker, result, rerender, client } = mounted();
    act(() => result.current.commit({ start: 12, end: 25, channelMask: 1 }));
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.addAnchor("region", "Verse");
      void result.current.addAnchor("marker", "ignored");
    });
    expect(worker.calls("regions.add")[0]).toMatchObject({
      params: { documentId: "doc-1", start: 12, end: 25, name: "Verse" },
    });
    expect(worker.calls("markers.add")).toHaveLength(0);
    const added = {
      ...timeline,
      regions: [{ id: 1, start: 12, end: 25, name: "Verse", color: "#a78bfa" }],
    };
    await act(async () =>
      worker.reply(worker.calls("regions.add")[0], { ...added, history, changed: true }),
    );
    await pending;
    await act(async () => worker.reply(worker.calls("timeline.get")[0], timeline));
    expect(result.current.timeline).toEqual(added);
    act(() => {
      pending = result.current.addAnchor("marker", "End");
    });
    rerender({ client, info: { ...info, documentId: "doc-2" } });
    await act(async () => worker.reply(worker.calls("markers.add")[0], added));
    await pending;
    expect(result.current.timeline).toEqual({ ...timeline, documentId: "doc-2" });
  });

  it("holds the shared lock, snapshots committed controls, and survives its own busy update", async () => {
    let enter!: () => Promise<void>;
    let release!: () => void;
    const withOperation = vi.fn(
      (work: () => Promise<void>) =>
        new Promise<void>((resolve) => {
          enter = work;
          release = resolve;
        }),
    );
    const onTimelineChanged = vi.fn();
    const options = { withOperation, onTimelineChanged };
    const { result, worker, rerender, client } = mounted(false, undefined, options);
    act(() => result.current.commit({ start: 12, end: 25, channelMask: 2 }));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.addAnchor("marker", "Cue", "#123456");
    });
    expect(result.current.adding).toBe(true);
    expect(worker.calls("markers.add")).toHaveLength(0);
    rerender({ client, info, options: { ...options, busy: true } });
    let work!: Promise<void>;
    act(() => {
      work = enter();
    });
    expect(worker.calls("markers.add")[0]).toMatchObject({
      params: {
        documentId: "doc-1",
        frame: 12,
        name: "Cue",
        color: "#123456",
        selection: { start: 12, end: 25, channelMask: 2 },
      },
    });
    const changed = {
      ...timeline,
      markers: [{ id: 1, frame: 12, name: "Cue", color: "#123456" }],
      history,
      changed: true,
    };
    await act(async () => {
      worker.reply(worker.calls("markers.add")[0], changed);
      await work;
    });
    expect(onTimelineChanged).toHaveBeenCalledWith(changed, "doc-1");
    // The external workflow still owns the physical lock even after its RPC settles.
    expect(result.current.adding).toBe(true);
    await act(async () => {
      release();
      await pending;
    });
    expect(result.current.adding).toBe(false);
    expect(worker.calls("transport.stop")).toHaveLength(0);
  });

  it("refuses metadata mutations during a pointer preview or external workflow", async () => {
    const { worker, result, rerender, client } = mounted();
    act(() => result.current.preview({ start: 1, end: 2, channelMask: 1 }));
    await act(async () => {
      await result.current.addAnchor("marker", "Cue");
      await result.current.updateMarker({ id: 1, frame: 3, name: "Cue" });
      await result.current.removeRegion(2);
    });
    expect(worker.calls("markers.add")).toHaveLength(0);
    expect(worker.calls("markers.update")).toHaveLength(0);
    expect(worker.calls("regions.remove")).toHaveLength(0);
    act(() => result.current.cancelPreview());
    rerender({ client, info, options: { busy: true } });
    await act(async () => result.current.addAnchor("marker", "blocked"));
    expect(worker.calls("markers.add")).toHaveLength(0);
  });

  it.each([
    [
      "markers.update",
      (hook: ReturnType<typeof useSelection>) =>
        hook.updateMarker({ id: 1, frame: 90, name: "Cue", color: "#abcdef" }),
      { id: 1, frame: 90, name: "Cue", color: "#abcdef" },
    ],
    [
      "regions.update",
      (hook: ReturnType<typeof useSelection>) =>
        hook.updateRegion({ id: 2, start: 30, end: 50, name: "Verse", color: "#123456" }),
      { id: 2, start: 30, end: 50, name: "Verse", color: "#123456" },
    ],
    ["markers.remove", (hook: ReturnType<typeof useSelection>) => hook.removeMarker(1), { id: 1 }],
    ["regions.remove", (hook: ReturnType<typeof useSelection>) => hook.removeRegion(2), { id: 2 }],
  ] as const)(
    "sends explicit identity and committed channel subset for %s",
    async (method, run, fields) => {
      const onTimelineChanged = vi.fn();
      const { worker, result } = mounted(false, seeded, { onTimelineChanged });
      let pending!: Promise<void>;
      act(() => {
        pending = run(result.current);
      });
      expect(worker.calls(method)[0]).toMatchObject({
        params: {
          documentId: "doc-1",
          selection: { start: 100, end: 200, channelMask: 2 },
          ...fields,
        },
      });
      const changed = { ...timeline, history, changed: true };
      await act(async () => {
        worker.reply(worker.calls(method)[0], changed);
        await pending;
      });
      expect(onTimelineChanged).toHaveBeenCalledWith(changed, "doc-1");
      expect(result.current.timeline).toEqual(timeline);
    },
  );

  it.each([true, false])(
    "accepts timeline/history but only advances selection acknowledgement when changed=%s",
    async (changed) => {
      const onTimelineChanged = vi.fn();
      const { result, worker } = mounted(false, seeded, { onTimelineChanged });
      let pending!: Promise<void>;
      act(() => {
        pending = result.current.removeMarker(1);
      });
      const snapshot = { ...timeline, history, changed };
      await act(async () => {
        worker.reply(worker.calls("markers.remove")[0], snapshot);
        await pending;
      });
      await act(async () => {
        worker.reply(worker.calls("timeline.get")[0], seeded.timeline);
        worker.reply(worker.calls("selection.get")[0], { ...initial, start: 5, end: 6 });
      });
      expect(result.current.timeline).toEqual(timeline);
      expect(result.current.selection).toEqual(
        changed ? { start: 100, end: 200, channelMask: 2 } : { start: 5, end: 6, channelMask: 3 },
      );
      expect(onTimelineChanged).toHaveBeenCalledWith(snapshot, "doc-1");
    },
  );

  it("keeps metadata acknowledgement newer than an old SET when the next SET rejects", async () => {
    const { worker, result } = mounted();
    act(() => {
      result.current.commit({ start: 10, end: 20, channelMask: 1 });
      result.current.commit({ start: 30, end: 40, channelMask: 2 });
    });
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.addAnchor("marker", "Latest");
    });
    await act(async () => {
      worker.reply(worker.calls("markers.add")[0], { ...timeline, history, changed: true });
      await pending;
    });
    await act(async () =>
      worker.reply(worker.calls("selection.set")[0], {
        ...initial,
        start: 10,
        end: 20,
        channelMask: 1,
      }),
    );
    await act(async () => worker.fail(worker.calls("selection.set")[1]));
    expect(result.current.selection).toEqual({ start: 30, end: 40, channelMask: 2 });
  });

  it("does not release its physical mutation lock on document/client replacement", async () => {
    const onTimelineChanged = vi.fn();
    const { worker, result, rerender } = mounted(false, undefined, { onTimelineChanged });
    let old!: Promise<void>;
    act(() => {
      old = result.current.addAnchor("marker", "Old");
    });
    const replacementWorker = new DeferredWorker();
    const replacementClient = new KernelClient(replacementWorker);
    rerender({
      client: replacementClient,
      info: { ...info, documentId: "doc-2" },
      options: { onTimelineChanged },
    });
    expect(result.current.adding).toBe(true);
    await act(async () => result.current.addAnchor("marker", "Blocked"));
    expect(replacementWorker.calls("markers.add")).toHaveLength(0);
    await act(async () => {
      worker.reply(worker.calls("markers.add")[0], { ...timeline, history, changed: true });
      await old;
    });
    expect(result.current.adding).toBe(false);
    expect(onTimelineChanged).not.toHaveBeenCalled();
    expect(result.current.timeline.documentId).toBe("doc-2");
    let next!: Promise<void>;
    act(() => {
      next = result.current.addAnchor("marker", "New");
    });
    expect(replacementWorker.calls("markers.add")).toHaveLength(1);
    await act(async () => {
      replacementWorker.fail(replacementWorker.calls("markers.add")[0]);
      await next;
    });
    expect(result.current.error).toBe("rejected");
  });

  it("restores captured controls adopted atomically after a preceding SET rejection", async () => {
    const { worker, result } = mounted(false, seeded);
    act(() => result.current.commit({ start: 30, end: 40, channelMask: 1 }));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.addAnchor("marker", "Cue");
    });
    await act(async () => worker.fail(worker.calls("selection.set")[0]));
    expect(result.current.selection).toEqual({ start: 100, end: 200, channelMask: 2 });
    await act(async () => {
      worker.reply(worker.calls("markers.add")[0], { ...timeline, history, changed: true });
      await pending;
    });
    expect(result.current.selection).toEqual({ start: 30, end: 40, channelMask: 1 });
    expect(result.current.error).toBeUndefined();
  });

  it.each(["unmount", "document", "selection"] as const)(
    "does not issue a queued mutation after %s changes during lock acquisition",
    async (change) => {
      let enter!: () => Promise<void>;
      const withOperation = (work: () => Promise<void>) => {
        enter = work;
        return Promise.resolve();
      };
      const { worker, result, rerender, client, unmount } = mounted(false, undefined, {
        withOperation,
      });
      await act(async () => result.current.addAnchor("marker", "Cue"));
      if (change === "unmount") unmount();
      else if (change === "document") rerender({ client, info: { ...info, documentId: "doc-2" } });
      else act(() => result.current.commit({ start: 1, end: 2, channelMask: 3 }));
      await act(async () => enter());
      expect(worker.calls("markers.add")).toHaveLength(0);
    },
  );

  it("surfaces shared-lock failure and ignores a response after unmount", async () => {
    const onTimelineChanged = vi.fn();
    const { worker, result, rerender, client, unmount } = mounted(false, undefined, {
      withOperation: async () => {
        throw new Error("Another workflow is active");
      },
      onTimelineChanged,
    });
    await act(async () => result.current.addAnchor("marker", "Cue"));
    expect(result.current.error).toBe("Another workflow is active");
    expect(result.current.adding).toBe(false);
    expect(worker.calls("markers.add")).toHaveLength(0);
    rerender({ client, info, options: { onTimelineChanged } });
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.addAnchor("marker", "Cue");
    });
    unmount();
    await act(async () => {
      worker.reply(worker.calls("markers.add")[0], { ...timeline, history, changed: true });
      await pending;
    });
    expect(onTimelineChanged).not.toHaveBeenCalled();
  });
});
