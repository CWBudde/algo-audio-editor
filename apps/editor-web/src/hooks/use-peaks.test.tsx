import type { PeaksGetParams, PeaksGetResult } from "@aae/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelClient, type WorkerLike } from "@/kernel/client";
import type { WorkerReply, WorkerRequest } from "@/kernel/messages";
import { MAX_SAMPLE_VIEW_FRAMES } from "@/lib/waveform-samples";
import { type SamplePeaksParams, usePeaks, useSamplePeaks, useWaveformPeaks } from "./use-peaks";

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

function sampleFixture(start: number, count: number): PeaksGetResult {
  const data = new ArrayBuffer(count * 24);
  const triples = new Float32Array(data, 0, count * 3);
  const counts = new Uint32Array(data, count * 12, count);
  const starts = new Float64Array(data, count * 16, count);
  for (let index = 0; index < count; index++) {
    triples[index * 3] = triples[index * 3 + 1] = index % 2 ? 0.5 : -0.5;
    triples[index * 3 + 2] = 0.5;
    counts[index] = 1;
    starts[index] = start + index;
  }
  return { data, count, dataBytes: data.byteLength, framesPerBucket: 1 };
}

function setupSamples(
  params: SamplePeaksParams | undefined = { channel: 0, startFrame: 0, endFrame: 8193 },
  strict = false,
) {
  const worker = new PeakWorker();
  const client = new KernelClient(worker, { timeoutMs: 60_000 });
  const props: {
    client: KernelClient | undefined;
    documentKey: object;
    params: SamplePeaksParams | undefined;
  } = { client, documentKey: {}, params };
  const hook = renderHook(
    ({ client, documentKey, params }: typeof props) => useSamplePeaks(client, documentKey, params),
    {
      initialProps: props,
      wrapper: strict ? StrictMode : undefined,
    },
  );
  return { ...hook, worker, client, props };
}

describe("useSamplePeaks", () => {
  it("shares one physical lane while switching envelope to sample detail", async () => {
    const worker = new PeakWorker();
    const client = new KernelClient(worker, { timeoutMs: 60_000 });
    const documentKey = {};
    const props = { params: viewport, samples: false };
    const hook = renderHook(
      ({ params, samples }: typeof props) => useWaveformPeaks(client, documentKey, params, samples),
      { initialProps: props },
    );
    await flush();
    hook.rerender({
      params: { channel: 0, startFrame: 1, endFrame: 3, buckets: 2 },
      samples: true,
    });
    await flush();
    expect(worker.sent).toHaveLength(1);
    expect(hook.result.current.pages).toBeUndefined();
    await act(async () => worker.reply(0, fixture()));
    await flush();
    expect(worker.sent).toHaveLength(2);
    await act(async () => worker.reply(1, sampleFixture(1, 2)));
    expect(hook.result.current.pages?.[0].frameCounts).toEqual(new Uint32Array([1, 1]));
  });
  it("pages exact8192-frame requests sequentially and publishes complete zero-copy views only", async () => {
    const s = setupSamples();
    await flush();
    expect(s.worker.sent).toHaveLength(1);
    expect(s.worker.sent[0]).toMatchObject({
      method: "peaks.get",
      params: { channel: 0, startFrame: 0, endFrame: 8192, buckets: 8192 },
    });
    const first = sampleFixture(0, 8192);
    await act(async () => s.worker.reply(0, first));
    expect(s.result.current).toEqual({ pages: undefined, loading: true, error: undefined });
    expect(s.worker.sent).toHaveLength(2);
    expect(s.worker.sent[1]).toMatchObject({
      params: { channel: 0, startFrame: 8192, endFrame: 8193, buckets: 1 },
    });
    const final = sampleFixture(8192, 1);
    await act(async () => s.worker.reply(1, final));
    expect(s.result.current.loading).toBe(false);
    expect(s.result.current.pages).toHaveLength(2);
    expect(s.result.current.pages?.[0].peaks.buffer).toBe(first.data);
    expect(s.result.current.pages?.[1].peaks.buffer).toBe(final.data);
  });

  it("coalesces latest viewport changes and never schedules remaining stale pages", async () => {
    const s = setupSamples();
    await flush();
    s.rerender({ ...s.props, params: { channel: 0, startFrame: 100, endFrame: 8293 } });
    s.rerender({ ...s.props, params: { channel: 0, startFrame: 400, endFrame: 8593 } });
    await flush();
    expect(s.worker.sent).toHaveLength(1);
    await act(async () => s.worker.reply(0, sampleFixture(0, 8192)));
    await flush();
    expect(s.worker.sent).toHaveLength(2);
    expect(s.worker.sent[1]).toMatchObject({
      params: { startFrame: 400, endFrame: 8592, buckets: 8192 },
    });
    await act(async () => s.worker.reply(1, sampleFixture(400, 8192)));
    await act(async () => s.worker.reply(2, sampleFixture(8592, 1)));
    expect(s.result.current.pages?.[0].startFrames[0]).toBe(400);
  });

  it("discards partially collected pages when document/client changes and preserves physical occupancy", async () => {
    const s = setupSamples();
    await flush();
    await act(async () => s.worker.reply(0, sampleFixture(0, 8192)));
    expect(s.worker.sent).toHaveLength(2);
    const nextWorker = new PeakWorker();
    const nextClient = new KernelClient(nextWorker, { timeoutMs: 60_000 });
    s.rerender({
      ...s.props,
      client: nextClient,
      documentKey: {},
      params: { channel: 1, startFrame: 2, endFrame: 4 },
    });
    await flush();
    expect(nextWorker.sent).toHaveLength(0);
    expect(s.result.current.pages).toBeUndefined();
    await act(async () => s.worker.reply(1, sampleFixture(8192, 1)));
    await flush();
    expect(nextWorker.sent).toHaveLength(1);
    await act(async () => nextWorker.reply(0, sampleFixture(2, 2)));
    expect(s.result.current.pages).toHaveLength(1);
    expect(s.result.current.pages?.[0].startFrames[0]).toBe(2);
  });

  it("does not refetch equal query fields and waits until inputs exist in StrictMode", async () => {
    const s = setupSamples({ channel: 0, startFrame: 2, endFrame: 4 }, true);
    await flush();
    expect(s.worker.sent).toHaveLength(1);
    await act(async () => s.worker.reply(0, sampleFixture(2, 2)));
    const pages = s.result.current.pages;
    s.rerender({ ...s.props, params: { ...(s.props.params as SamplePeaksParams) } });
    await flush();
    expect(s.worker.sent).toHaveLength(1);
    expect(s.result.current.pages).toBe(pages);
    s.rerender({ ...s.props, params: undefined });
    await flush();
    expect(s.result.current).toEqual({ pages: undefined, loading: false, error: undefined });
  });

  it.each([() => fixture(), () => sampleFixture(0, 1), () => sampleFixture(1, 2)])(
    "rejects aggregate/missing/mispositioned detail page %# rather than inferring samples",
    async (response) => {
      const s = setupSamples({ channel: 0, startFrame: 0, endFrame: 2 });
      await flush();
      await act(async () => s.worker.reply(0, response()));
      expect(s.result.current.loading).toBe(false);
      expect(s.result.current.pages).toBeUndefined();
      expect(s.result.current.error).toMatch(/sample detail/);
    },
  );

  it("keeps final safe frame offsets precise and bounds oversized/invalid logical requests before any RPC", async () => {
    const end = Number.MAX_SAFE_INTEGER;
    const s = setupSamples({ channel: 0, startFrame: end - 2, endFrame: end });
    await flush();
    expect(s.worker.sent[0]).toMatchObject({
      params: { startFrame: end - 2, endFrame: end, buckets: 2 },
    });
    await act(async () => s.worker.reply(0, sampleFixture(end - 2, 2)));
    expect(Array.from(s.result.current.pages?.[0].startFrames ?? [])).toEqual([end - 2, end - 1]);
    for (const params of [
      { channel: 0, startFrame: 0, endFrame: MAX_SAMPLE_VIEW_FRAMES + 1 },
      { channel: 0, startFrame: NaN, endFrame: 2 },
      { channel: 0, startFrame: 0, endFrame: 0 },
    ]) {
      s.rerender({ ...s.props, params });
      await flush();
      expect(s.result.current.error).toMatch(/valid bounded frame range/);
      expect(s.worker.sent).toHaveLength(1);
    }
  });

  it("releases partial pages on error/unmount without queuing later pages", async () => {
    const s = setupSamples({ channel: 0, startFrame: 0, endFrame: 16385 });
    await flush();
    await act(async () => s.worker.reply(0, sampleFixture(0, 8192)));
    await act(async () => s.worker.fail(1, "sample page failed"));
    expect(s.result.current).toEqual({
      pages: undefined,
      loading: false,
      error: "sample page failed",
    });
    expect(s.worker.sent).toHaveLength(2);
    s.rerender({ ...s.props, params: { channel: 1, startFrame: 0, endFrame: 16385 } });
    await flush();
    s.unmount();
    await act(async () => s.worker.reply(2, sampleFixture(0, 8192)));
    await flush();
    expect(s.worker.sent).toHaveLength(3);
  });
});

describe("usePeaks", () => {
  it("retains the last completed same-document viewport while replacements load and coalesce", async () => {
    const s = setup();
    await flush();
    await act(async () => s.worker.reply(0, fixture()));
    const drawn = s.result.current.data;
    s.rerender({ ...s.props, params: { ...viewport, startFrame: 128 } });
    expect(s.result.current.data).toBe(drawn);
    expect(s.result.current.loading).toBe(true);
    await flush();
    s.rerender({ ...s.props, params: { ...viewport, startFrame: 256 } });
    await act(async () => s.worker.reply(1, fixture(128)));
    expect(s.result.current.data).toBe(drawn);
    await flush();
    await act(async () => s.worker.reply(2, fixture(256)));
    expect(s.result.current.data?.startFrames[0]).toBe(256);
    expect(s.result.current.loading).toBe(false);
    s.rerender({ ...s.props, documentKey: {} });
    expect(s.result.current.data).toBeUndefined();
  });

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
