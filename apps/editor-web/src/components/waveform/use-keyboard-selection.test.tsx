import type { DocumentInfoResult, EditResult, SelectionRange } from "@aae/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSelection } from "@/hooks/use-selection";
import { KernelClient, type WorkerLike } from "@/kernel/client";
import type { WorkerReply, WorkerRequest } from "@/kernel/messages";
import { useKeyboardSelection } from "./use-keyboard-selection";

const info: DocumentInfoResult = {
  documentId: "doc-1",
  name: "test.wav",
  sampleRate: 48000,
  channels: 2,
  frames: 48000,
  bitDepth: 16,
  float: false,
};
const initial: Pick<EditResult, "selection" | "timeline"> = {
  selection: { documentId: info.documentId, start: 100, end: 200, channelMask: 2 },
  timeline: { documentId: info.documentId, markers: [], regions: [] },
};
const original: SelectionRange = { start: 100, end: 200, channelMask: 2 };
const first: SelectionRange = { start: 110, end: 200, channelMask: 2 };
const last: SelectionRange = { start: 130, end: 200, channelMask: 2 };

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
      data: { kind: "reply", id: request.id, ok: false, error: "selection rejected" },
    } as MessageEvent<WorkerReply>);
  }
}

interface HookProps {
  client: KernelClient | undefined;
  info: DocumentInfoResult;
  initial?: typeof initial;
  disabled: boolean;
  onSeek: (frame: number) => void;
}

function mounted(strict = false) {
  const worker = new DeferredWorker();
  const client = new KernelClient(worker);
  const onSeek = vi.fn();
  const props: HookProps = { client, info, initial, disabled: false, onSeek };
  return {
    worker,
    props,
    onSeek,
    ...renderHook(
      (options: HookProps) => {
        const editor = useSelection(options.client, options.info, options.initial);
        const keyboard = useKeyboardSelection({ ...options, editor });
        return { editor, keyboard };
      },
      { initialProps: props, wrapper: strict ? StrictMode : undefined },
    ),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useKeyboardSelection", () => {
  it("previews repeat input immediately and commits/seeks the last range after 80 ms idle", () => {
    const { result, worker, onSeek } = mounted();
    act(() => result.current.keyboard.change(first, first.start));
    expect(result.current.editor.selection).toEqual(first);
    expect(result.current.editor.previewing).toBe(true);
    expect(result.current.keyboard.ownsPreview()).toBe(true);
    expect(worker.calls("selection.set")).toHaveLength(0);
    act(() => vi.advanceTimersByTime(60));
    act(() => result.current.keyboard.change(last, last.start));
    act(() => vi.advanceTimersByTime(79));
    expect(worker.calls("selection.set")).toHaveLength(0);
    expect(onSeek).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(worker.calls("selection.set")).toHaveLength(1);
    expect(worker.calls("selection.set")[0]).toMatchObject({
      params: { documentId: info.documentId, ...last },
    });
    expect(onSeek).toHaveBeenCalledExactlyOnceWith(last.start);
    expect(result.current.editor.previewing).toBe(false);
    expect(result.current.keyboard.ownsPreview()).toBe(false);
  });

  it("flushes once on keyup/blur and cancel after flush retains committed controls", () => {
    const { result, worker, onSeek } = mounted(true);
    act(() => {
      result.current.keyboard.change(first, 110);
      result.current.keyboard.flush();
      result.current.keyboard.flush();
      result.current.keyboard.cancel();
    });
    act(() => vi.advanceTimersByTime(100));
    expect(result.current.editor.selection).toEqual(first);
    expect(worker.calls("selection.set")).toHaveLength(1);
    expect(onSeek).toHaveBeenCalledExactlyOnceWith(110);
  });

  it("exposes the committed range for another keyboard change in the same turn", async () => {
    const { result, worker, onSeek } = mounted();
    const cursor = { start: 110, end: 110, channelMask: 2 };
    act(() => {
      result.current.keyboard.change(cursor, cursor.start);
      result.current.keyboard.flush();
      const live = result.current.editor.getSelection();
      expect(live).toBe(cursor);
      const next = { ...live, start: live.start + 1, end: live.end + 1 };
      result.current.keyboard.change(next, next.start);
      result.current.keyboard.flush();
    });
    expect(result.current.editor.selection).toEqual({ start: 111, end: 111, channelMask: 2 });
    expect(onSeek.mock.calls).toEqual([[110], [111]]);
    await act(async () =>
      worker.reply(worker.calls("selection.set")[0], { ...cursor, documentId: info.documentId }),
    );
    expect(worker.calls("selection.set")).toHaveLength(2);
    expect(worker.calls("selection.set")[1]).toMatchObject({
      params: { documentId: info.documentId, start: 111, end: 111, channelMask: 2 },
    });
  });

  it("rolls its own cancelled preview back without any RPC or seek", () => {
    const { result, worker, onSeek } = mounted();
    act(() => {
      result.current.keyboard.change(first, 110);
      result.current.keyboard.cancel();
    });
    act(() => vi.advanceTimersByTime(100));
    expect(result.current.editor.selection).toEqual(original);
    expect(result.current.editor.previewing).toBe(false);
    expect(worker.calls("selection.set")).toHaveLength(0);
    expect(onSeek).not.toHaveBeenCalled();
  });

  it.each(["cancel", "flush", "timeout"] as const)(
    "preserves a superseding pointer preview during %s, including before a rerender",
    (action) => {
      const { result, worker, onSeek } = mounted();
      const pointer = { start: 300, end: 400, channelMask: 1 };
      act(() => {
        result.current.keyboard.change(first, 110);
        result.current.editor.preview(pointer);
        if (action === "cancel") result.current.keyboard.cancel();
        if (action === "flush") result.current.keyboard.flush();
      });
      act(() => vi.advanceTimersByTime(100));
      expect(result.current.editor.selection).toEqual(pointer);
      expect(result.current.editor.previewing).toBe(true);
      expect(result.current.keyboard.ownsPreview()).toBe(false);
      expect(worker.calls("selection.set")).toHaveLength(0);
      expect(onSeek).not.toHaveBeenCalled();
    },
  );

  it("preserves a superseding numeric commit instead of replaying the keyboard range", () => {
    const { result, worker, onSeek } = mounted();
    const numeric = { start: 600, end: 700, channelMask: 1 };
    act(() => {
      result.current.keyboard.change(first, 110);
      result.current.editor.commit(numeric);
    });
    act(() => vi.advanceTimersByTime(100));
    expect(result.current.editor.selection).toEqual(numeric);
    expect(worker.calls("selection.set")).toHaveLength(1);
    expect(worker.calls("selection.set")[0]).toMatchObject({ params: numeric });
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("does not start keyboard editing over a pointer preview", () => {
    const { result, worker } = mounted();
    const pointer = { start: 300, end: 400, channelMask: 1 };
    act(() => result.current.editor.preview(pointer));
    act(() => result.current.keyboard.change(first, 110));
    act(() => vi.advanceTimersByTime(100));
    expect(result.current.editor.selection).toEqual(pointer);
    expect(worker.calls("selection.set")).toHaveLength(0);
  });

  it("refuses a new keyboard range when a pointer takes ownership before a rerender", () => {
    const { result, worker, onSeek } = mounted();
    const pointer = { start: 300, end: 400, channelMask: 1 };
    act(() => {
      result.current.keyboard.change(first, 110);
      result.current.editor.preview(pointer);
      result.current.keyboard.change(last, 130);
    });
    act(() => vi.advanceTimersByTime(100));
    expect(result.current.editor.selection).toEqual(pointer);
    expect(result.current.editor.previewing).toBe(true);
    expect(worker.calls("selection.set")).toHaveLength(0);
    expect(onSeek).not.toHaveBeenCalled();
  });

  it.each(["document", "client", "session", "busy", "unmount"] as const)(
    "cancels pending keyboard input on %s replacement",
    (replacement) => {
      const { result, worker, onSeek, rerender, props, unmount } = mounted();
      act(() => result.current.keyboard.change(first, 110));
      const replacementWorker = new DeferredWorker();
      if (replacement === "unmount") unmount();
      else
        rerender({
          ...props,
          client: replacement === "client" ? new KernelClient(replacementWorker) : props.client,
          info: replacement === "document" ? { ...info, documentId: "doc-2" } : info,
          initial:
            replacement === "session"
              ? { ...initial, selection: { ...initial.selection, start: 500, end: 600 } }
              : initial,
          disabled: replacement === "busy",
        });
      act(() => vi.advanceTimersByTime(100));
      expect(worker.calls("selection.set")).toHaveLength(0);
      expect(replacementWorker.calls("selection.set")).toHaveLength(0);
      expect(onSeek).not.toHaveBeenCalled();
      if (replacement === "busy") {
        expect(result.current.editor.selection).toEqual(original);
        expect(result.current.editor.previewing).toBe(false);
        act(() => result.current.keyboard.change(last, 130));
        act(() => vi.advanceTimersByTime(100));
        expect(worker.calls("selection.set")).toHaveLength(0);
      }
    },
  );

  it("uses the latest seek callback and drops a superseded seek during selection-only changes", () => {
    const { result, worker, rerender, props, onSeek } = mounted();
    const replacementSeek = vi.fn();
    act(() => result.current.keyboard.change(first, 110));
    rerender({ ...props, onSeek: replacementSeek });
    act(() => result.current.keyboard.flush());
    expect(onSeek).not.toHaveBeenCalled();
    expect(replacementSeek).toHaveBeenCalledExactlyOnceWith(110);
    act(() => {
      result.current.keyboard.change(last, 130);
      result.current.keyboard.change({ ...last, end: 250 });
      result.current.keyboard.flush();
    });
    // The selection lane is still awaiting the first ACK; seeking is never
    // deferred into its response callback.
    expect(worker.calls("selection.set")).toHaveLength(1);
    expect(replacementSeek).toHaveBeenCalledTimes(1);
  });

  it("never seeks again when a delayed selection ACK arrives after numeric input", async () => {
    const { result, worker, onSeek } = mounted();
    act(() => {
      result.current.keyboard.change(first, 110);
      result.current.keyboard.flush();
    });
    const numeric = { start: 1000, end: 2000, channelMask: 1 };
    act(() => result.current.editor.commit(numeric));
    await act(async () =>
      worker.reply(worker.calls("selection.set")[0], { ...first, documentId: info.documentId }),
    );
    expect(worker.calls("selection.set")).toHaveLength(2);
    expect(result.current.editor.selection).toEqual(numeric);
    expect(onSeek).toHaveBeenCalledExactlyOnceWith(110);
    await act(async () =>
      worker.reply(worker.calls("selection.set")[1], { ...numeric, documentId: info.documentId }),
    );
    expect(onSeek).toHaveBeenCalledTimes(1);
  });

  it("retains useSelection rollback and error reporting on a rejected keyboard commit", async () => {
    const { result, worker, onSeek } = mounted();
    act(() => {
      result.current.keyboard.change(first, 110);
      result.current.keyboard.flush();
    });
    await act(async () => worker.fail(worker.calls("selection.set")[0]));
    expect(result.current.editor.selection).toEqual(original);
    expect(result.current.editor.error).toBe("selection rejected");
    expect(onSeek).toHaveBeenCalledExactlyOnceWith(110);
  });
});
