import type { PeaksGetParams, PeaksGetResult } from "@aae/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelClient, type WorkerLike } from "@/kernel/client";
import type { WorkerReply, WorkerRequest } from "@/kernel/messages";
import { usePeaks } from "./use-peaks";

class PeakWorker implements WorkerLike {
  sent: WorkerRequest[] = [];
  private listener?: (event: MessageEvent<WorkerReply>) => void;

  postMessage(message: WorkerRequest) {
    this.sent.push(message);
  }

  addEventListener(_type: "message", listener: (event: MessageEvent<WorkerReply>) => void) {
    this.listener = listener;
  }

  terminate() {}

  reply(index: number, result: PeaksGetResult) {
    this.listener?.({
      data: { kind: "reply", id: this.sent[index].id, ok: true, result },
    } as MessageEvent<WorkerReply>);
  }

  fail(index: number, error = "unavailable") {
    this.listener?.({
      data: { kind: "reply", id: this.sent[index].id, ok: false, error },
    } as MessageEvent<WorkerReply>);
  }
}

function fixture(startFrame = 0): PeaksGetResult {
  const data = new ArrayBuffer(24);
  new Float32Array(data, 0, 3).set([-0.5, 0.75, 0.25]);
  new Uint32Array(data, 12, 1)[0] = 16;
  new Float64Array(data, 16, 1)[0] = startFrame;
  return { data, count: 1, dataBytes: 24, framesPerBucket: 16 };
}

const viewport: PeaksGetParams = { channel: 0, startFrame: 0, endFrame: 1024, buckets: 64 };
type Props = {
  client: KernelClient | undefined;
  documentKey: object;
  params: PeaksGetParams | undefined;
};

function setup(initialProps?: Partial<Props>, strict = false) {
  const worker = new PeakWorker();
  const client = new KernelClient(worker, { timeoutMs: 60_000 });
  const props: Props = { client, documentKey: {}, params: viewport, ...initialProps };
  const hook = renderHook(
    ({ client, documentKey, params }: Props) => usePeaks(client, documentKey, params),
    {
      initialProps: props,
      wrapper: strict ? StrictMode : undefined,
    },
  );
  return { ...hook, worker, client, props };
}

async function flush() {
  await act(() => vi.advanceTimersByTimeAsync(0));
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("usePeaks", () => {
  it("waits for inputs, then exposes zero-copy peak views", async () => {
    const { result, worker, client, props, rerender } = setup({ client: undefined });
    await flush();
    expect(worker.sent).toHaveLength(0);
    expect(result.current).toEqual({ data: undefined, loading: false, error: undefined });

    rerender({ ...props, client });
    expect(result.current.loading).toBe(true);
    await flush();
    expect(worker.sent[0]).toMatchObject({ op: "call", method: "peaks.get", params: viewport });
    const response = fixture();
    await act(async () => worker.reply(0, response));
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeUndefined();
    expect(Array.from(result.current.data?.peaks ?? [])).toEqual([-0.5, 0.75, 0.25]);
    expect(result.current.data?.peaks.buffer).toBe(response.data);
    expect(result.current.data?.frameCounts.buffer).toBe(response.data);
    expect(result.current.data?.startFrames.buffer).toBe(response.data);
  });

  it("coalesces rapid A/B/C changes into A then C, discarding A's late completion", async () => {
    const { result, worker, props, rerender } = setup();
    await flush();
    const b = { ...viewport, startFrame: 128 };
    const c = { ...viewport, startFrame: 256, buckets: 100 };
    rerender({ ...props, params: b });
    await flush();
    rerender({ ...props, params: c });
    await flush();
    expect(worker.sent).toHaveLength(1);
    await act(async () => worker.reply(0, fixture()));
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(true);
    await flush();
    expect(worker.sent).toHaveLength(2);
    expect(worker.sent[1]).toMatchObject({ method: "peaks.get", params: c });
    await act(async () => worker.reply(1, fixture(256)));
    expect(result.current.data?.startFrames[0]).toBe(256);
  });

  it("hides old data immediately and avoids repeats for equal viewport fields", async () => {
    const { result, worker, props, rerender } = setup();
    await flush();
    await act(async () => worker.reply(0, fixture()));
    rerender({ ...props, params: { ...viewport } });
    await flush();
    expect(worker.sent).toHaveLength(1);
    expect(result.current.data).toBeDefined();
    rerender({ ...props, params: { ...viewport, channel: 1 } });
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(true);
    await flush();
    expect(worker.sent[1]).toMatchObject({ params: { ...viewport, channel: 1 } });
  });

  it("invalidates same-dimension documents and waits for the old client's physical request", async () => {
    const { result, worker, props, rerender } = setup();
    await flush();
    const newWorker = new PeakWorker();
    const newClient = new KernelClient(newWorker, { timeoutMs: 60_000 });
    rerender({ ...props, client: newClient, documentKey: {} });
    await flush();
    expect(newWorker.sent).toHaveLength(0);
    expect(result.current.data).toBeUndefined();
    await act(async () => worker.reply(0, fixture(512)));
    await flush();
    expect(newWorker.sent).toHaveLength(1);
    expect(result.current.data).toBeUndefined();
    await act(async () => newWorker.reply(0, fixture(0)));
    expect(result.current.data?.startFrames[0]).toBe(0);
    rerender({ ...props, client: newClient, documentKey: {} });
    expect(result.current.data).toBeUndefined();
    await flush();
    expect(newWorker.sent).toHaveLength(2);
  });

  it("does not resurrect data when the viewport returns to A before its original reply", async () => {
    const { result, worker, props, rerender } = setup();
    await flush();
    rerender({ ...props, params: { ...viewport, startFrame: 128 } });
    rerender(props);
    await act(async () => worker.reply(0, fixture(512)));
    expect(result.current.data).toBeUndefined();
    await flush();
    expect(worker.sent).toHaveLength(2);
    await act(async () => worker.reply(1, fixture()));
    expect(result.current.data?.startFrames[0]).toBe(0);
  });

  it("reports failures and recovers after subsequent parameters", async () => {
    const { result, worker, props, rerender } = setup();
    await flush();
    await act(async () => worker.fail(0));
    expect(result.current).toEqual({ data: undefined, loading: false, error: "unavailable" });
    rerender({ ...props, params: { ...viewport, endFrame: 512 } });
    expect(result.current.error).toBeUndefined();
    await flush();
    await act(async () => worker.reply(1, fixture()));
    expect(result.current.data).toBeDefined();
    expect(result.current.error).toBeUndefined();
  });

  it("rejects malformed packed peaks and recovers on the next viewport", async () => {
    const { result, worker, props, rerender } = setup();
    await flush();
    await act(async () => worker.reply(0, { ...fixture(), dataBytes: 4 }));
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toMatch(/length/);
    rerender({ ...props, params: { ...viewport, buckets: 32 } });
    await flush();
    await act(async () => worker.reply(1, fixture()));
    expect(result.current.data).toBeDefined();
  });

  it("ignores obsolete failures while serving the latest pending request", async () => {
    const { result, worker, props, rerender } = setup();
    await flush();
    rerender({ ...props, documentKey: {} });
    await act(async () => worker.fail(0, "old document unavailable"));
    expect(result.current.error).toBeUndefined();
    await flush();
    await act(async () => worker.reply(1, fixture()));
    expect(result.current.data).toBeDefined();
  });

  it("issues only one request through StrictMode's effect replay", async () => {
    const { worker, result } = setup(undefined, true);
    await flush();
    expect(worker.sent).toHaveLength(1);
    await act(async () => worker.reply(0, fixture()));
    await flush();
    expect(worker.sent).toHaveLength(1);
    expect(result.current.data).toBeDefined();
  });

  it("keeps independent channel lanes moving when another lane is still waiting", async () => {
    const worker = new PeakWorker();
    const client = new KernelClient(worker, { timeoutMs: 60_000 });
    const documentKey = {};
    const { result, rerender } = renderHook(
      ({ startFrame }) => ({
        left: usePeaks(client, documentKey, { ...viewport, startFrame, channel: 0 }),
        right: usePeaks(client, documentKey, { ...viewport, startFrame, channel: 1 }),
      }),
      { initialProps: { startFrame: 0 } },
    );
    await flush();
    expect(worker.sent).toHaveLength(2);
    rerender({ startFrame: 128 });
    await act(async () => worker.reply(0, fixture()));
    await flush();
    expect(worker.sent).toHaveLength(3);
    expect(worker.sent[2]).toMatchObject({ params: { channel: 0, startFrame: 128 } });
    expect(result.current.right.data).toBeUndefined();
    await act(async () => worker.reply(2, fixture(128)));
    expect(result.current.left.data?.startFrames[0]).toBe(128);
    expect(result.current.right.loading).toBe(true);
  });

  it("cancels the initial queued request on immediate unmount", async () => {
    const { worker, unmount } = setup();
    unmount();
    await flush();
    expect(worker.sent).toHaveLength(0);
  });

  it("discards disabled and unmounted requests without draining pending work", async () => {
    const { worker, props, result, rerender, unmount } = setup();
    await flush();
    rerender({ ...props, params: undefined });
    expect(result.current).toEqual({ data: undefined, loading: false, error: undefined });
    await act(async () => worker.reply(0, fixture()));
    await flush();
    expect(worker.sent).toHaveLength(1);
    rerender(props);
    await flush();
    rerender({ ...props, params: { ...viewport, buckets: 128 } });
    unmount();
    await act(async () => worker.reply(1, fixture()));
    await flush();
    expect(worker.sent).toHaveLength(2);
  });
});
