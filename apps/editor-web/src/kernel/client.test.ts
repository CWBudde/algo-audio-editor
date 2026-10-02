import { type PeaksGetResult, PROTOCOL_VERSION } from "@aae/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KernelClient, KernelError, KernelTimeoutError, type WorkerLike } from "./client";
import type { WorkerReply, WorkerRequest } from "./messages";

/** In-memory worker whose replies are scripted by the test. */
class FakeWorker implements WorkerLike {
  sent: WorkerRequest[] = [];
  terminated = false;
  private listener?: (event: MessageEvent<WorkerReply>) => void;
  private readonly respond?: (req: WorkerRequest) => WorkerReply | undefined;

  constructor(respond?: (req: WorkerRequest) => WorkerReply | undefined) {
    this.respond = respond;
  }

  postMessage(message: WorkerRequest) {
    this.sent.push(message);
    const reply = this.respond?.(message);
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

afterEach(() => {
  vi.useRealTimers();
});

describe("KernelClient", () => {
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
});
