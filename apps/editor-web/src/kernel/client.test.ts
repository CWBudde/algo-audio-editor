import {
  type DocumentInfoResult,
  type ExportResult,
  type PeaksGetResult,
  PROTOCOL_VERSION,
  type ProcessJobResult,
} from "@aae/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KernelClient, KernelError, KernelTimeoutError, type WorkerLike } from "./client";
import type { WorkerReply, WorkerRequest } from "./messages";

/** In-memory worker whose replies are scripted by the test. */
class FakeWorker implements WorkerLike {
  sent: WorkerRequest[] = [];
  transfers: (Transferable[] | undefined)[] = [];
  terminated = false;
  private listener?: (event: MessageEvent<WorkerReply>) => void;
  private readonly respond?: (req: WorkerRequest) => WorkerReply | undefined;

  constructor(respond?: (req: WorkerRequest) => WorkerReply | undefined) {
    this.respond = respond;
  }

  postMessage(message: WorkerRequest, transfer?: Transferable[]) {
    this.transfers.push(transfer);
    const received = transfer ? structuredClone(message, { transfer }) : message;
    this.sent.push(received);
    const reply = this.respond?.(received);
    if (reply) queueMicrotask(() => this.emit(reply));
  }
  addEventListener(_type: "message", listener: (event: MessageEvent<WorkerReply>) => void) {
    this.listener = listener;
  }
  terminate() {
    this.terminated = true;
  }
  emit(reply: WorkerReply) {
    this.listener?.({ data: reply } as MessageEvent<WorkerReply>);
  }
}

const hello = (protocolVersion = PROTOCOL_VERSION) => ({
  protocolVersion,
  kernelVersion: "test",
  buildTime: "",
  goVersion: "go1.25",
  sampleRate: 48000,
  channels: 2,
});
const job = { documentId: "doc-1", jobId: "job-1" };
const progress: ProcessJobResult = {
  ...job,
  start: 10,
  end: 30,
  channelMask: 3,
  state: "running",
  operation: "gain",
  gainDb: 6,
  processedFrames: 1,
  totalFrames: 20,
  peak: 0.5,
  nonFinite: false,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("KernelClient", () => {
  it("moves binary WAV input to the worker outside the JSON params", async () => {
    const info: DocumentInfoResult = {
      documentId: "doc-1",
      name: "test.wav",
      sampleRate: 44100,
      channels: 1,
      frames: 2,
      bitDepth: 16,
      float: false,
    };
    const worker = new FakeWorker((req) => ({ kind: "reply", id: req.id, ok: true, result: info }));
    const client = new KernelClient(worker);
    const bytes = new Uint8Array([82, 73, 70, 70]).buffer;
    const pending = client.openDocument(info.name, bytes);
    expect(bytes.byteLength).toBe(0);
    expect(worker.transfers[0]).toEqual([bytes]);
    expect(worker.sent[0]).toMatchObject({ method: "doc.open", params: { name: "test.wav" } });
    if (worker.sent[0].op !== "call") throw new Error("expected call");
    expect(Array.from(new Uint8Array(worker.sent[0].data as ArrayBuffer))).toEqual([
      82, 73, 70, 70,
    ]);
    await expect(pending).resolves.toEqual(info);
  });

  it("returns exported WAV bytes with the received buffer identity", async () => {
    const result: ExportResult = {
      name: "test.wav",
      mimeType: "audio/wav",
      dataBytes: 4,
      data: new ArrayBuffer(4),
    };
    const worker = new FakeWorker((req) => ({ kind: "reply", id: req.id, ok: true, result }));
    const client = new KernelClient(worker);
    const received = await client.call("doc.export", { format: "wav", bitDepth: 32, float: true });
    expect(received.data).toBe(result.data);
    expect(received.mimeType).toBe("audio/wav");
  });

  it("allows long imports and exports to finish after the normal RPC timeout", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const client = new KernelClient(worker, { timeoutMs: 10 });
    const pending = client.openDocument("long.wav", new ArrayBuffer(0));
    vi.advanceTimersByTime(1_000);
    worker.emit({ kind: "reply", id: worker.sent[0].id, ok: true, result: undefined });
    await expect(pending).resolves.toBeUndefined();
    const exported = client.call("doc.export", { format: "wav", bitDepth: 16, float: false });
    vi.advanceTimersByTime(1_000);
    worker.emit({ kind: "reply", id: worker.sent[1].id, ok: true, result: undefined });
    await expect(exported).resolves.toBeUndefined();
  });

  it("cleans up pending requests when posting a transfer throws", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    vi.spyOn(worker, "postMessage").mockImplementation(() => {
      throw new DOMException("invalid transfer", "DataCloneError");
    });
    const client = new KernelClient(worker);
    await expect(client.openDocument("test.wav", new ArrayBuffer(0))).rejects.toThrow(
      "invalid transfer",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns typed peak metadata and the received binary buffer without copying it", async () => {
    const data = new ArrayBuffer(24);
    new Float32Array(data, 0, 3).set([-0.5, 0.75, 0.25]);
    new Uint32Array(data, 12, 1)[0] = 128;
    new Float64Array(data, 16, 1)[0] = 256;
    const peaks: PeaksGetResult = { count: 1, framesPerBucket: 256, dataBytes: 24, data };
    const worker = new FakeWorker((req) => ({
      kind: "reply",
      id: req.id,
      ok: true,
      result: peaks,
    }));
    const client = new KernelClient(worker);
    const params = { channel: 0, startFrame: 256, endFrame: 384, buckets: 1 };

    const result = await client.call("peaks.get", params);
    expect(result.count).toBe(1);
    expect(result.data).toBe(data);
    expect(new Float32Array(result.data, 0, 3)).toEqual(new Float32Array([-0.5, 0.75, 0.25]));
    expect(worker.sent[0]).toMatchObject({ op: "call", method: "peaks.get", params });
  });

  it("boots and checks the protocol version", async () => {
    const worker = new FakeWorker((req) =>
      req.op === "call"
        ? { kind: "reply", id: req.id, ok: true, result: hello() }
        : { kind: "reply", id: req.id, ok: true, result: undefined },
    );
    const client = new KernelClient(worker);

    await expect(client.boot("/k.wasm", "/wasm_exec.js")).resolves.toMatchObject({
      kernelVersion: "test",
    });
    expect(worker.sent.map((m) => m.op)).toEqual(["init", "call"]);
  });

  it("rejects a kernel with a different protocol version", async () => {
    const worker = new FakeWorker((req) =>
      req.op === "call"
        ? { kind: "reply", id: req.id, ok: true, result: hello(PROTOCOL_VERSION + 1) }
        : { kind: "reply", id: req.id, ok: true, result: undefined },
    );
    await expect(new KernelClient(worker).boot("/k.wasm", "/x.js")).rejects.toThrow(/protocol/);
  });

  it("passes params and maps kernel errors to KernelError", async () => {
    const worker = new FakeWorker((req) => ({
      kind: "reply",
      id: req.id,
      ok: false,
      error: "tone.configure: tone amplitude 2 outside [0, 1]",
    }));
    const client = new KernelClient(worker);

    const result = client.call("tone.configure", { frequencyHz: 440, amplitude: 2 });
    await expect(result).rejects.toBeInstanceOf(KernelError);
    await expect(result).rejects.toThrow(/amplitude 2/);
    expect(worker.sent[0]).toMatchObject({
      op: "call",
      method: "tone.configure",
      params: { frequencyHz: 440, amplitude: 2 },
    });
  });

  it("matches replies to requests by id, in any order", async () => {
    const worker = new FakeWorker();
    const client = new KernelClient(worker);

    const a = client.call("hello");
    const b = client.call("engine.configure", { sampleRate: 44100, channels: 1 });
    worker.emit({ kind: "reply", id: worker.sent[1].id, ok: true, result: "b" });
    worker.emit({ kind: "reply", id: worker.sent[0].id, ok: true, result: "a" });

    await expect(a).resolves.toBe("a");
    await expect(b).resolves.toBe("b");
  });

  it("times out unanswered requests", async () => {
    vi.useFakeTimers();
    const client = new KernelClient(new FakeWorker(), { timeoutMs: 100 });

    const pending = client.call("hello");
    vi.advanceTimersByTime(100);
    await expect(pending).rejects.toBeInstanceOf(KernelTimeoutError);
  });

  it("fails pending and future requests after a fatal event", async () => {
    const worker = new FakeWorker();
    const client = new KernelClient(worker);
    const onFatal = vi.fn();
    client.onFatal(onFatal);

    const pending = client.call("hello");
    worker.emit({ kind: "fatal", error: "kernel exited" });

    await expect(pending).rejects.toThrow(/kernel exited/);
    await expect(client.call("hello")).rejects.toThrow(/kernel exited/);
    expect(onFatal).toHaveBeenCalledWith("kernel exited");

    // Late subscribers still learn about it.
    const late = vi.fn();
    client.onFatal(late);
    expect(late).toHaveBeenCalledWith("kernel exited");
  });

  it("terminate rejects pending requests", async () => {
    const worker = new FakeWorker();
    const client = new KernelClient(worker);
    const pending = client.call("hello");

    client.terminate();
    expect(worker.terminated).toBe(true);
    await expect(pending).rejects.toThrow(/terminated/);
    await expect(client.call("hello")).rejects.toThrow(/terminated/);
  });

  it("runs a single long processing RPC while matching heartbeats extend only inactivity timeout", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const client = new KernelClient(worker, { timeoutMs: 10, processTimeoutMs: 100 });
    const listener = vi.fn();
    const pending = client.runProcess(job, listener);
    expect(worker.sent).toEqual([{ id: 1, op: "process.run", ...job }]);
    for (let processedFrames = 1; processedFrames <= 4; processedFrames++) {
      vi.advanceTimersByTime(60);
      worker.emit({ kind: "process.progress", id: 1, progress: { ...progress, processedFrames } });
    }
    const ready = { ...progress, state: "ready" as const, processedFrames: 20 };
    worker.emit({ kind: "process.progress", id: 1, progress: ready });
    worker.emit({ kind: "reply", id: 1, ok: true, result: ready });
    await expect(pending).resolves.toEqual(ready);
    expect(listener).toHaveBeenCalledTimes(5);
    expect(worker.sent).toHaveLength(1);
    expect(worker.terminated).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    worker.emit({ kind: "process.progress", id: 1, progress: ready });
    expect(listener).toHaveBeenCalledTimes(5);
  });

  it("allows a separate Cancel RPC to finish the runner without committing or duplicate callbacks", async () => {
    const worker = new FakeWorker();
    const client = new KernelClient(worker);
    const listener = vi.fn();
    const running = client.runProcess(job, listener);
    worker.emit({ kind: "process.progress", id: 1, progress });
    const cancel = client.call("process.cancel", job);
    const cancelled = { ...progress, state: "cancelled" as const };
    worker.emit({ kind: "reply", id: 2, ok: true, result: cancelled });
    worker.emit({ kind: "process.progress", id: 1, progress: cancelled });
    worker.emit({ kind: "process.progress", id: 1, progress: cancelled });
    worker.emit({ kind: "reply", id: 1, ok: true, result: cancelled });
    await expect(cancel).resolves.toEqual(cancelled);
    await expect(running).resolves.toEqual(cancelled);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(
      worker.sent.map((request) => (request.op === "call" ? request.method : request.op)),
    ).toEqual(["process.run", "process.cancel"]);
  });

  it("kills the worker and notifies fatal owners before releasing a stalled job and other RPCs", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const client = new KernelClient(worker, { timeoutMs: 1000, processTimeoutMs: 100 });
    const order: string[] = [];
    vi.spyOn(worker, "terminate").mockImplementation(() => {
      worker.terminated = true;
      order.push("terminate");
    });
    client.onFatal(() => order.push("fatal"));
    const pending = client.runProcess(job);
    const other = client.call("hello");
    const rejected = pending.catch((error: unknown) => {
      order.push("reject");
      throw error;
    });
    const assertion = expect(rejected).rejects.toBeInstanceOf(KernelTimeoutError);
    const otherAssertion = expect(other).rejects.toBeInstanceOf(KernelTimeoutError);
    vi.advanceTimersByTime(100);
    await Promise.all([assertion, otherAssertion]);
    expect(order).toEqual(["terminate", "fatal", "reject"]);
    expect(vi.getTimerCount()).toBe(0);
    await expect(client.call("hello")).rejects.toThrow("inactive");
  });

  it.each(["process.start", "process.step", "process.cancel", "process.commit"] as const)(
    "uses fatal timeout fencing for %s even without an active runner",
    async (method) => {
      vi.useFakeTimers();
      const worker = new FakeWorker();
      const client = new KernelClient(worker, { timeoutMs: 10 });
      const onFatal = vi.fn(() => expect(worker.terminated).toBe(true));
      client.onFatal(onFatal);
      const pending =
        method === "process.start"
          ? client.call(method, {
              ...job,
              start: 10,
              end: 30,
              channelMask: 3,
              operation: "gain",
              gainDb: 6,
            })
          : client.call(method, job);
      const assertion = expect(pending).rejects.toBeInstanceOf(KernelTimeoutError);
      vi.advanceTimersByTime(10);
      await assertion;
      expect(onFatal).toHaveBeenCalledOnce();
      worker.emit({
        kind: "reply",
        id: worker.sent[0].id,
        ok: true,
        result: { ...progress, state: "ready", processedFrames: 20 },
      });
      await expect(client.call("hello")).rejects.toThrow("timed out");
    },
  );

  it.each([
    { jobId: "other" },
    { documentId: "other" },
    { processedFrames: 21 },
    { peak: Number.NaN },
    { totalFrames: 1.5 },
  ])(
    "ignores malformed or wrong-job progress %j without refreshing the watchdog",
    async (changes) => {
      vi.useFakeTimers();
      const worker = new FakeWorker();
      const client = new KernelClient(worker, { processTimeoutMs: 100 });
      const listener = vi.fn();
      const pending = client.runProcess(job, listener);
      const assertion = expect(pending).rejects.toBeInstanceOf(KernelTimeoutError);
      vi.advanceTimersByTime(60);
      worker.emit({ kind: "process.progress", id: 1, progress: { ...progress, ...changes } });
      worker.emit({ kind: "process.progress", id: 999, progress });
      vi.advanceTimersByTime(40);
      await assertion;
      expect(listener).not.toHaveBeenCalled();
    },
  );

  it("ignores duplicate and backwards progress so a stuck loop cannot keep its watchdog alive", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const client = new KernelClient(worker, { processTimeoutMs: 100 });
    const listener = vi.fn();
    const pending = client.runProcess(job, listener);
    const assertion = expect(pending).rejects.toBeInstanceOf(KernelTimeoutError);
    vi.advanceTimersByTime(20);
    worker.emit({ kind: "process.progress", id: 1, progress });
    vi.advanceTimersByTime(60);
    worker.emit({ kind: "process.progress", id: 1, progress });
    worker.emit({ kind: "process.progress", id: 1, progress: { ...progress, processedFrames: 0 } });
    vi.advanceTimersByTime(40);
    await assertion;
    expect(listener).toHaveBeenCalledOnce();
  });

  it("contains subscriber exceptions and does not let listener mutations poison progress validation", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const client = new KernelClient(worker);
    const pending = client.runProcess(job, (value) => {
      value.processedFrames = 999;
      throw new Error("observer failed");
    });
    worker.emit({ kind: "process.progress", id: 1, progress: { ...progress } });
    const ready = { ...progress, state: "ready" as const, processedFrames: 20 };
    worker.emit({ kind: "reply", id: 1, ok: true, result: ready });
    await expect(pending).resolves.toEqual(ready);
    expect(vi.getTimerCount()).toBe(0);
    client.onFatal(() => {
      throw new Error("fatal observer failed");
    });
    client.terminate();
    await expect(client.call("hello")).rejects.toThrow("terminated");
  });

  it("ignores progress for normal RPC IDs and reports invalid nonterminal runner replies", async () => {
    const worker = new FakeWorker();
    const client = new KernelClient(worker);
    const ordinary = client.call("hello");
    worker.emit({ kind: "process.progress", id: 1, progress });
    worker.emit({ kind: "reply", id: 1, ok: true, result: hello() });
    await expect(ordinary).resolves.toEqual(hello());
    const running = client.runProcess(job);
    worker.emit({ kind: "reply", id: 2, ok: true, result: progress });
    await expect(running).rejects.toThrow("invalid terminal progress");
  });

  it("cleans up a runner watchdog when postMessage fails or the client terminates", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const client = new KernelClient(worker);
    vi.spyOn(worker, "postMessage").mockImplementationOnce(() => {
      throw new Error("post failed");
    });
    await expect(client.runProcess(job)).rejects.toThrow("post failed");
    expect(vi.getTimerCount()).toBe(0);
    const pending = client.runProcess(job);
    client.terminate();
    await expect(pending).rejects.toThrow("terminated");
    expect(vi.getTimerCount()).toBe(0);
  });
});
