import type {
  DocumentInfoResult,
  EditResult,
  SelectionResult,
  TimelineResult,
} from "@aae/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelClient, type WorkerLike } from "@/kernel/client";
import type { WorkerReply, WorkerRequest } from "@/kernel/messages";
import { useSelection } from "./use-selection";

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
}

function mounted(strict = false, seed?: SelectionSeed) {
  const worker = new DeferredWorker();
  const client = new KernelClient(worker);
  const initialProps: HookProps = { client, info, initial: seed };
  return {
    worker,
    client,
    ...renderHook(({ client, info, initial }: HookProps) => useSelection(client, info, initial), {
      initialProps,
      wrapper: strict ? StrictMode : undefined,
    }),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useSelection", () => {
  const seeded: SelectionSeed = {
    selection: { ...initial, start: 100, end: 200, channelMask: 2 },
    timeline: {
      ...timeline,
      markers: [{ id: 1, frame: 150, name: "Cue" }],
      regions: [{ id: 2, start: 100, end: 200, name: "Verse" }],
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
        markers: [{ id: 1, frame: 7, name: "Cue" }],
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
    const existing = { ...timeline, markers: [{ id: 1, frame: 100, name: "Existing" }] };
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
    act(() => result.current.preview({ start: 12, end: 25, channelMask: 1 }));
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.addAnchor("region", "Verse");
      void result.current.addAnchor("marker", "ignored");
    });
    expect(worker.calls("regions.add")[0]).toMatchObject({
      params: { documentId: "doc-1", start: 12, end: 25, name: "Verse" },
    });
    expect(worker.calls("markers.add")).toHaveLength(0);
    const added = { ...timeline, regions: [{ id: 1, start: 12, end: 25, name: "Verse" }] };
    await act(async () => worker.reply(worker.calls("regions.add")[0], added));
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
});
