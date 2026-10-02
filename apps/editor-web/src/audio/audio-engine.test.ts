import { afterEach, describe, expect, it, vi } from "vitest";
import { KernelClient, type WorkerLike } from "@/kernel/client";
import type { WorkerReply, WorkerRequest } from "@/kernel/messages";
import { AudioEngine } from "./audio-engine";

class PlaybackWorker implements WorkerLike {
  sent: WorkerRequest[] = [];
  hold = "engine.configure";
  private listener?: (event: MessageEvent<WorkerReply>) => void;
  postMessage(request: WorkerRequest) {
    this.sent.push(request);
    const operation = request.op === "call" ? request.method : request.op;
    if (operation !== this.hold) queueMicrotask(() => this.reply(request));
  }
  addEventListener(_type: "message", listener: (event: MessageEvent<WorkerReply>) => void) {
    this.listener = listener;
  }
  terminate() {}
  reply(request: WorkerRequest) {
    this.listener?.({
      data: { kind: "reply", id: request.id, ok: true, result: undefined },
    } as MessageEvent<WorkerReply>);
  }
}

function context() {
  const ctx = {
    sampleRate: 48000,
    destination: {},
    audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
    suspend: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  vi.stubGlobal(
    "AudioContext",
    class {
      sampleRate = ctx.sampleRate;
      destination = ctx.destination;
      audioWorklet = ctx.audioWorklet;
      suspend = ctx.suspend;
      resume = ctx.resume;
      close = ctx.close;
    },
  );
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      connect() {}
    },
  );
  return ctx;
}

afterEach(() => vi.unstubAllGlobals());

describe("AudioEngine stopping before import", () => {
  it("waits for an in-progress setup and does not start the tone after stopping", async () => {
    const ctx = context();
    const worker = new PlaybackWorker();
    const engine = new AudioEngine(new KernelClient(worker));
    const playing = engine.play();
    await vi.waitFor(() => expect(worker.sent).toHaveLength(1));
    const stopping = engine.stop();
    worker.reply(worker.sent[0]);
    await Promise.all([playing, stopping]);
    expect(worker.sent.some((request) => request.op === "stream.start")).toBe(false);
    expect(worker.sent.some((request) => request.op === "stream.stop")).toBe(true);
    expect(ctx.resume).not.toHaveBeenCalled();
    expect(engine.stats()?.bufferedFrames).toBe(0);
  });

  it("does not resume a stopped context when an earlier stream-prime reply arrives late", async () => {
    const ctx = context();
    const worker = new PlaybackWorker();
    worker.hold = "stream.start";
    const engine = new AudioEngine(new KernelClient(worker));
    const playing = engine.play();
    await vi.waitFor(() =>
      expect(worker.sent.some((request) => request.op === "stream.start")).toBe(true),
    );
    await engine.stop();
    const start = worker.sent.find((request) => request.op === "stream.start");
    if (!start) throw new Error("missing stream start");
    worker.reply(start);
    await playing;
    expect(ctx.resume).not.toHaveBeenCalled();
    expect(engine.stats()?.bufferedFrames).toBe(0);
  });
});
