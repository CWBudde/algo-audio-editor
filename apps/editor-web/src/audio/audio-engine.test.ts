import type { DocumentInfoResult, TransportPlayParams, TransportResult } from "@aae/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KernelClient, type WorkerLike } from "@/kernel/client";
import type { WorkerReply, WorkerRequest } from "@/kernel/messages";
import { AudioEngine } from "./audio-engine";
import { FrameRingBuffer } from "./ring-buffer";

const info: DocumentInfoResult = {
  documentId: "doc-1",
  name: "stereo.wav",
  channels: 2,
  sampleRate: 44100,
  frames: 44100,
  bitDepth: 16,
  float: false,
};
const params: TransportPlayParams = { start: 12, end: 40000, loop: false };

class PlaybackWorker implements WorkerLike {
  sent: WorkerRequest[] = [];
  hold: string | undefined;
  fail: string | undefined;
  ring: FrameRingBuffer | undefined;
  state: TransportResult = { start: 0, end: info.frames, loop: false, position: 0, playing: false };
  private listener?: (event: MessageEvent<WorkerReply>) => void;
  private results = new Map<number, unknown>();

  postMessage(request: WorkerRequest) {
    this.sent.push(request);
    const operation = request.op === "call" ? request.method : request.op;
    let result: unknown;
    if (request.op === "stream.attach") this.ring = FrameRingBuffer.attach(request.ring);
    if (request.op === "call") {
      if (request.method === "transport.play") {
        const play = request.params as TransportPlayParams;
        this.state = { ...play, end: play.end ?? info.frames, position: play.start, playing: true };
      } else if (request.method === "transport.stop") this.state.playing = false;
      else if (request.method === "transport.seek") {
        this.state.position = (request.params as { frame: number }).frame;
        if (this.state.position >= info.frames) this.state.playing = false;
      }
      if (request.method.startsWith("transport.")) result = { ...this.state };
    }
    this.results.set(request.id, result);
    if (operation !== this.hold) queueMicrotask(() => this.reply(request));
  }
  addEventListener(_type: "message", listener: (event: MessageEvent<WorkerReply>) => void) {
    this.listener = listener;
  }
  terminate() {}
  reply(request: WorkerRequest) {
    const operation = request.op === "call" ? request.method : request.op;
    const data: WorkerReply =
      operation === this.fail
        ? { kind: "reply", id: request.id, ok: false, error: "rejected" }
        : { kind: "reply", id: request.id, ok: true, result: this.results.get(request.id) };
    this.listener?.({ data } as MessageEvent<WorkerReply>);
  }
  operations() {
    return this.sent.map((request) => (request.op === "call" ? request.method : request.op));
  }
  latest(operation: string) {
    const request = this.sent.findLast(
      (request) => (request.op === "call" ? request.method : request.op) === operation,
    );
    if (!request) throw new Error(`missing ${operation}`);
    return request;
  }
}

function context() {
  const ctx = {
    sampleRate: 48000,
    destination: {},
    audioWorklet: { addModule: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) },
    suspend: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    resume: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    timestamp: undefined as (() => AudioTimestamp) | undefined,
    state: "running" as AudioContextState,
  };
  const construct = vi.fn();
  const nodes: {
    options: AudioWorkletNodeOptions;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }[] = [];
  vi.stubGlobal(
    "AudioContext",
    class {
      constructor(options?: AudioContextOptions) {
        construct(options);
      }
      sampleRate = ctx.sampleRate;
      destination = ctx.destination;
      audioWorklet = ctx.audioWorklet;
      suspend = ctx.suspend;
      resume = ctx.resume;
      close = ctx.close;
      get state() {
        return ctx.state;
      }
      get getOutputTimestamp() {
        return ctx.timestamp;
      }
    },
  );
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      connect = vi.fn();
      disconnect = vi.fn();
      constructor(_context: AudioContext, _processor: string, options: AudioWorkletNodeOptions) {
        nodes.push({ options, connect: this.connect, disconnect: this.disconnect });
      }
    },
  );
  return Object.assign(ctx, { construct, nodes });
}

function fixture() {
  const ctx = context();
  const worker = new PlaybackWorker();
  const engine = new AudioEngine(new KernelClient(worker));
  return { ctx, worker, engine };
}

async function waiting(worker: PlaybackWorker, operation: string) {
  await vi.waitFor(() => expect(worker.operations()).toContain(operation));
  return worker.latest(operation);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AudioEngine document playback", () => {
  it("creates context under gesture, configures document channels at hardware rate and primes before resume", async () => {
    const { ctx, worker, engine } = fixture();
    worker.hold = "stream.start";
    const play = engine.play(info, params);
    expect(ctx.construct).toHaveBeenCalledTimes(1);
    expect(ctx.construct).toHaveBeenCalledWith({ latencyHint: 0.001 });
    const prime = await waiting(worker, "stream.start");
    expect(ctx.resume).not.toHaveBeenCalled();
    expect(worker.latest("engine.configure")).toMatchObject({
      params: { sampleRate: 48000, channels: 2 },
    });
    expect(worker.latest("transport.play")).toMatchObject({ params });
    expect(ctx.nodes[0].options.outputChannelCount).toEqual([2]);
    worker.reply(prime);
    await play;
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    expect(engine.position()).toBe(12);
    expect(engine.sampleRate).toBe(48000);
  });

  it("uses a short queue for live effects, retains it across seeks and restores full buffering for document playback", async () => {
    const { worker, engine } = fixture();
    await engine.prepare(info);
    await engine.play(info, { ...params, effectPreviewId: "effects-1", loop: true });
    expect(worker.latest("stream.start")).toMatchObject({ maxBufferedFrames: 768 });
    await engine.seek(100);
    expect(worker.latest("stream.start")).toMatchObject({ maxBufferedFrames: 768 });
    await engine.play(info, params);
    expect(worker.latest("stream.start")).not.toHaveProperty("maxBufferedFrames");
  });

  it("always stops kernel transport even when no context has been created", async () => {
    const { ctx, worker, engine } = fixture();
    await engine.stop();
    expect(worker.operations()).toEqual(["stream.stop", "transport.stop"]);
    expect(ctx.construct).not.toHaveBeenCalled();
  });

  it("still stops the producer and kernel transport when context suspension fails", async () => {
    const { ctx, worker, engine } = fixture();
    await engine.play(info, params);
    ctx.suspend.mockRejectedValueOnce(new Error("suspend failed"));
    await expect(engine.stop()).rejects.toThrow("suspend failed");
    expect(worker.operations().slice(-2)).toEqual(["stream.stop", "transport.stop"]);
    expect(worker.state.playing).toBe(false);
    expect(engine.isPlaying()).toBe(false);
  });

  it("waits for setup and does not start document playback after stop/import supersedes play", async () => {
    const { ctx, worker, engine } = fixture();
    worker.hold = "engine.configure";
    const playing = engine.play(info, params);
    const configure = await waiting(worker, "engine.configure");
    const stopping = engine.stop();
    worker.reply(configure);
    await Promise.all([playing, stopping]);
    expect(worker.operations()).not.toContain("transport.play");
    expect(worker.operations()).not.toContain("stream.start");
    expect(worker.operations()).toContain("transport.stop");
    expect(ctx.resume).not.toHaveBeenCalled();
    expect(engine.stats()?.bufferedFrames).toBe(0);
  });

  it("stops without waiting for a late prime reply and never resumes that stale play", async () => {
    const { ctx, worker, engine } = fixture();
    worker.hold = "stream.start";
    const playing = engine.play(info, params);
    const prime = await waiting(worker, "stream.start");
    await engine.stop();
    worker.reply(prime);
    await playing;
    expect(ctx.resume).not.toHaveBeenCalled();
    expect(engine.position()).toBe(params.start);
  });

  it("waits for a pending resume before suspend so it cannot revive stopped audio", async () => {
    const { ctx, worker, engine } = fixture();
    let finishResume: (() => void) | undefined;
    ctx.resume.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishResume = resolve;
        }),
    );
    const playing = engine.play(info, params);
    await vi.waitFor(() => expect(finishResume).toBeDefined());
    const suspended = ctx.suspend.mock.calls.length;
    const stopping = engine.stop();
    await Promise.resolve();
    expect(ctx.suspend.mock.calls.length).toBe(suspended);
    finishResume?.();
    await Promise.all([playing, stopping]);
    expect(ctx.suspend.mock.calls.length).toBeGreaterThan(suspended);
    expect(worker.state.playing).toBe(false);
  });

  it("serializes rapid stop/play and recreates channel graph without reloading the worklet", async () => {
    const { ctx, worker, engine } = fixture();
    await engine.play(info, params);
    const stopping = engine.stop();
    const playing = engine.play({ ...info, channels: 6 }, { start: 25, loop: true });
    await Promise.all([stopping, playing]);
    expect(ctx.nodes.map((node) => node.options.outputChannelCount)).toEqual([[2], [6]]);
    expect(ctx.nodes[0].disconnect).toHaveBeenCalledOnce();
    expect(ctx.audioWorklet.addModule).toHaveBeenCalledOnce();
    expect(worker.ring?.channels).toBe(6);
    expect(engine.position()).toBe(25);
    expect(worker.state).toMatchObject({ position: 25, loop: true, playing: true });
  });

  it("seeks while playing by quiescing, resetting tagged cursor and re-priming without changing range/loop", async () => {
    const { ctx, worker, engine } = fixture();
    await engine.play(info, { ...params, loop: true });
    worker.ring?.write(new Float32Array(8), 4, BigInt64Array.from([13n, 14n, 15n, 16n]));
    worker.ring?.readPlanar([new Float32Array(2), new Float32Array(2)], 2);
    expect(engine.position()).toBe(14);
    await engine.seek(200);
    expect(worker.state).toMatchObject({
      start: 12,
      end: 40000,
      loop: true,
      position: 200,
      playing: true,
    });
    expect(engine.position()).toBe(200);
    expect(engine.stats()?.bufferedFrames).toBe(0);
    expect(ctx.resume).toHaveBeenCalledTimes(2);
    expect(worker.operations().filter((operation) => operation === "transport.play")).toHaveLength(
      1,
    );
  });

  it("seeks paused transport and EOF without starting audio", async () => {
    const { ctx, worker, engine } = fixture();
    await engine.seek(100);
    expect(engine.position()).toBe(100);
    expect(ctx.construct).not.toHaveBeenCalled();
    expect(worker.operations()).not.toContain("stream.start");
    await engine.play(info, params);
    await engine.seek(info.frames);
    expect(engine.position()).toBe(info.frames);
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    expect(worker.state.playing).toBe(false);
  });

  it("keeps play intent when seek supersedes initial graph setup", async () => {
    const { ctx, worker, engine } = fixture();
    worker.hold = "engine.configure";
    const playing = engine.play(info, params);
    const configure = await waiting(worker, "engine.configure");
    const seeking = engine.seek(500);
    worker.reply(configure);
    await Promise.all([playing, seeking]);
    expect(worker.state).toMatchObject({ position: 500, playing: true });
    expect(engine.position()).toBe(500);
    expect(ctx.resume).toHaveBeenCalledOnce();
  });

  it("handles seek in the same gesture before initial setup has begun", async () => {
    const { ctx, worker, engine } = fixture();
    const playing = engine.play(info, params);
    const seeking = engine.seek(300);
    await Promise.all([playing, seeking]);
    expect(ctx.nodes).toHaveLength(1);
    expect(worker.ring?.channels).toBe(2);
    expect(worker.state).toMatchObject({ position: 300, playing: true });
    expect(engine.position()).toBe(300);
    expect(engine.isPlaying()).toBe(true);
  });

  it("supersedes a pending seek without reviving playback or exposing stale cursor", async () => {
    const { ctx, worker, engine } = fixture();
    await engine.play(info, params);
    worker.hold = "transport.seek";
    const seeking = engine.seek(500);
    const seek = await waiting(worker, "transport.seek");
    const stopping = engine.stop();
    // Stop is queued behind seek; its generation invalidates seek immediately.
    worker.reply(seek);
    await Promise.all([seeking, stopping]);
    expect(engine.position()).toBe(params.start);
    expect(worker.state.playing).toBe(false);
    expect(engine.isPlaying()).toBe(false);
    expect(ctx.resume).toHaveBeenCalledOnce();
  });

  it("retries a failed setup without resuming a half-built graph", async () => {
    const { ctx, worker, engine } = fixture();
    ctx.audioWorklet.addModule.mockRejectedValueOnce(new Error("worklet failed"));
    await expect(engine.play(info, params)).rejects.toThrow("worklet failed");
    expect(ctx.resume).not.toHaveBeenCalled();
    expect(worker.operations()).toContain("transport.stop");
    await engine.play(info, params);
    expect(ctx.nodes).toHaveLength(1);
    expect(ctx.resume).toHaveBeenCalledOnce();
  });

  it("exposes EOF drained state and clears it before replay", async () => {
    const { worker, engine } = fixture();
    await engine.play(info, params);
    worker.ring?.markEnd();
    expect(engine.ended()).toBe(true);
    await engine.play(info, params);
    expect(engine.ended()).toBe(false);
    expect(engine.position()).toBe(params.start);
    await engine.dispose();
    expect(engine.stats()).toBeUndefined();
  });

  it("closes preview browser resources even when its worker has already died", async () => {
    const ctx = context();
    const client = new KernelClient(new PlaybackWorker());
    const engine = new AudioEngine(client);
    await engine.play(info, { ...params, previewJobId: "process-1", loop: true });
    client.terminate();
    await expect(engine.dispose()).rejects.toThrow("kernel unavailable");
    expect(ctx.nodes[0]?.disconnect).toHaveBeenCalledOnce();
    expect(ctx.close).toHaveBeenCalledOnce();
    expect(engine.sampleRate).toBeUndefined();
    expect(engine.stats()).toBeUndefined();
    expect(engine.isPlaying()).toBe(false);
  });

  it("clears disposed references even when closing the browser context rejects", async () => {
    const { ctx, engine } = fixture();
    await engine.play(info, params);
    ctx.close.mockRejectedValueOnce(new Error("context close"));
    await expect(engine.dispose()).rejects.toThrow("context close");
    expect(ctx.nodes[0]?.disconnect).toHaveBeenCalledOnce();
    expect(engine.sampleRate).toBeUndefined();
    expect(engine.stats()).toBeUndefined();
  });

  it("maps stale device timestamps to retained audible tags instead of ring-ahead consumption", async () => {
    const { ctx, worker, engine } = fixture();
    vi.spyOn(performance, "now").mockReturnValue(1000);
    ctx.timestamp = () => ({ contextTime: 0, performanceTime: 0 });
    await engine.play(info, params);
    worker.ring?.write(
      new Float32Array(256),
      128,
      BigInt64Array.from({ length: 128 }, (_, index) => BigInt(13 + index)),
    );
    worker.ring?.readPlanar([new Float32Array(128), new Float32Array(128)], 128, 48000);
    expect(engine.stats()?.documentFrame).toBe(140);
    expect(engine.position()).toBe(12);
    ctx.timestamp = () => ({ contextTime: 1, performanceTime: 999 });
    expect(engine.position()).toBeGreaterThanOrEqual(60);
    expect(engine.position()).toBeLessThanOrEqual(61);
    ctx.timestamp = () => ({ contextTime: 1, performanceTime: 900 });
    expect(engine.position()).toBe(140); // extrapolation cannot outrun published history
    ctx.state = "suspended";
    ctx.timestamp = () => ({ contextTime: 1, performanceTime: 900 });
    expect(engine.position()).toBe(13); // no wall-clock extrapolation while suspended
  });

  it("tracks exact audible loop wrap, delays EOF and resets cursor history on seek", async () => {
    const { ctx, worker, engine } = fixture();
    ctx.timestamp = () => ({ contextTime: (48000 + 2.5) / 48000, performanceTime: 0 });
    await engine.play(info, { start: 10, end: 13, loop: true });
    worker.ring?.write(new Float32Array(8), 4, BigInt64Array.from([11n, 12n, 10n, 11n]));
    worker.ring?.readPlanar([new Float32Array(4), new Float32Array(4)], 4, 48000);
    expect(engine.position()).toBe(10);
    await engine.seek(500);
    expect(engine.position()).toBe(500);
    worker.ring?.write(new Float32Array(8), 4, BigInt64Array.from([501n, 502n, 503n, 504n]));
    worker.ring?.markEnd();
    worker.ring?.readPlanar([new Float32Array(128), new Float32Array(128)], 128, 49000);
    ctx.timestamp = () => ({ contextTime: (49000 + 3.5) / 48000, performanceTime: 0 });
    expect(engine.ended()).toBe(false);
    expect(engine.isPlaying()).toBe(true);
    ctx.timestamp = () => ({ contextTime: (49000 + 4.5) / 48000, performanceTime: 0 });
    expect(engine.ended()).toBe(true);
    expect(engine.isPlaying()).toBe(false);
    expect(engine.position()).toBe(504);
  });

  it("retains stopped consumed cursor while clearing playback counts and history", async () => {
    const { worker, engine } = fixture();
    await engine.play(info, params);
    worker.ring?.write(new Float32Array(8), 4, BigInt64Array.from([13n, 14n, 15n, 16n]));
    worker.ring?.readPlanar([new Float32Array(4), new Float32Array(4)], 4, 0);
    await engine.stop();
    expect(engine.position()).toBe(16);
    expect(engine.isPlaying()).toBe(false);
    expect(engine.stats()).toMatchObject({
      consumedFrames: 0,
      bufferedFrames: 0,
      documentFrame: 16,
    });
  });

  it("preserves audible Stop gesture position despite consumed-ahead frames and asynchronous drain", async () => {
    const { ctx, worker, engine } = fixture();
    vi.spyOn(performance, "now").mockReturnValue(1000);
    ctx.timestamp = () => ({ contextTime: (48000 + 32.5) / 48000, performanceTime: 1000 });
    await engine.play(info, params);
    worker.ring?.write(
      new Float32Array(256),
      128,
      BigInt64Array.from({ length: 128 }, (_, index) => BigInt(13 + index)),
    );
    worker.ring?.readPlanar([new Float32Array(128), new Float32Array(128)], 128, 48000);
    expect(engine.stats()?.documentFrame).toBe(140);
    expect(engine.position()).toBe(45);
    const stopping = engine.stop();
    expect(engine.position()).toBe(45);
    ctx.timestamp = () => ({ contextTime: (48000 + 128) / 48000, performanceTime: 1000 });
    await stopping;
    expect(engine.position()).toBe(45);
    expect(engine.stats()).toMatchObject({
      consumedFrames: 0,
      bufferedFrames: 0,
      documentFrame: 45,
    });
    await engine.play(info, { ...params, start: engine.position() });
    expect(worker.state.position).toBe(45);
  });

  it("shuts down safely after a failed seek rather than leaving logical playback suspended", async () => {
    const { worker, engine } = fixture();
    await engine.play(info, params);
    worker.fail = "transport.seek";
    await expect(engine.seek(300)).rejects.toThrow("rejected");
    expect(worker.state.playing).toBe(false);
    expect(engine.isPlaying()).toBe(false);
    expect(engine.position()).toBe(params.start);
    expect(engine.stats()?.bufferedFrames).toBe(0);
  });

  it("prepares a silent graph with synchronous gesture unlock, then plays a private preview without reconfiguration", async () => {
    const { ctx, worker, engine } = fixture();
    const preparing = engine.prepare(info);
    expect(ctx.construct).toHaveBeenCalledOnce();
    expect(ctx.resume).toHaveBeenCalledOnce();
    expect(worker.operations()).not.toContain("engine.configure");
    await preparing;
    expect(ctx.nodes[0].options.outputChannelCount).toEqual([2]);
    expect(engine.isPlaying()).toBe(false);
    expect(worker.operations()).not.toContain("stream.start");
    expect(worker.operations()).not.toContain("transport.play");
    expect(worker.operations()).toContain("transport.stop");
    const preview = { ...params, previewJobId: "job-1" };
    await engine.play(info, preview);
    expect(worker.latest("transport.play")).toMatchObject({ params: preview });
    expect(ctx.construct).toHaveBeenCalledOnce();
    expect(ctx.audioWorklet.addModule).toHaveBeenCalledOnce();
    expect(
      worker.operations().filter((operation) => operation === "engine.configure"),
    ).toHaveLength(1);
    expect(engine.isPlaying()).toBe(true);
  });

  it("preserves preview source identity when seek supersedes initial play setup", async () => {
    const { worker, engine } = fixture();
    worker.hold = "engine.configure";
    const preview = { ...params, loop: true, previewJobId: "job-1" };
    const playing = engine.play(info, preview);
    const configure = await waiting(worker, "engine.configure");
    const seeking = engine.seek(500);
    worker.reply(configure);
    await Promise.all([playing, seeking]);
    expect(worker.latest("transport.play")).toMatchObject({ params: preview });
    expect(worker.state).toMatchObject({ position: 500, playing: true });
    expect(engine.position()).toBe(500);
  });

  it("awaits gesture unlock before Stop and does not start stale preparation after it settles", async () => {
    const { ctx, worker, engine } = fixture();
    let finish!: () => void;
    ctx.resume.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const preparing = engine.prepare(info);
    const stopping = engine.stop();
    await Promise.resolve();
    expect(ctx.suspend).not.toHaveBeenCalled();
    finish();
    await Promise.all([preparing, stopping]);
    expect(ctx.suspend).toHaveBeenCalledOnce();
    expect(ctx.nodes).toHaveLength(0);
    expect(worker.operations()).toEqual(["stream.stop", "transport.stop"]);
    expect(engine.isPlaying()).toBe(false);
  });

  it("waits for late preparation setup during Stop and leaves no audible producer", async () => {
    const { ctx, worker, engine } = fixture();
    worker.hold = "engine.configure";
    const preparing = engine.prepare(info);
    const configure = await waiting(worker, "engine.configure");
    const stopping = engine.stop();
    worker.reply(configure);
    await Promise.all([preparing, stopping]);
    expect(ctx.resume).toHaveBeenCalledOnce(); // gesture unlock only, never a stale playback resume
    expect(worker.operations()).not.toContain("stream.start");
    expect(worker.operations()).not.toContain("transport.play");
    expect(worker.state.playing).toBe(false);
    expect(engine.stats()?.bufferedFrames).toBe(0);
  });

  it("serializes a newer play behind preparation and creates only its requested channel graph", async () => {
    const { ctx, worker, engine } = fixture();
    const preparing = engine.prepare(info);
    const playing = engine.play({ ...info, channels: 6 }, { ...params, previewJobId: "job-2" });
    await Promise.all([preparing, playing]);
    expect(ctx.nodes.map((node) => node.options.outputChannelCount)).toEqual([[6]]);
    expect(worker.ring?.channels).toBe(6);
    expect(worker.latest("transport.play")).toMatchObject({
      params: { ...params, previewJobId: "job-2" },
    });
    expect(engine.isPlaying()).toBe(true);
  });

  it("quiesces existing playback during preparation while retaining its audible cursor", async () => {
    const { worker, engine } = fixture();
    await engine.play(info, params);
    worker.ring?.write(new Float32Array(8), 4, BigInt64Array.from([13n, 14n, 15n, 16n]));
    worker.ring?.readPlanar([new Float32Array(4), new Float32Array(4)], 4);
    await engine.prepare(info);
    expect(engine.isPlaying()).toBe(false);
    expect(engine.position()).toBe(16);
    expect(worker.state.playing).toBe(false);
    expect(engine.stats()).toMatchObject({
      consumedFrames: 0,
      bufferedFrames: 0,
      documentFrame: 16,
    });
  });

  it("disposes safely while gesture preparation is pending and cannot revive its context", async () => {
    const { ctx, worker, engine } = fixture();
    let finish!: () => void;
    ctx.resume.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const preparing = engine.prepare(info);
    const disposing = engine.dispose();
    expect(ctx.close).not.toHaveBeenCalled();
    finish();
    await Promise.all([preparing, disposing]);
    expect(ctx.close).toHaveBeenCalledOnce();
    expect(ctx.nodes).toHaveLength(0);
    expect(worker.operations()).not.toContain("engine.configure");
    expect(engine.sampleRate).toBeUndefined();
    expect(engine.stats()).toBeUndefined();
  });

  it("contains a rejected gesture unlock and can retry preparation without starting transport", async () => {
    const { ctx, worker, engine } = fixture();
    ctx.resume.mockRejectedValueOnce(new Error("autoplay rejected"));
    await expect(engine.prepare(info)).rejects.toThrow("autoplay rejected");
    expect(worker.operations()).toContain("transport.stop");
    expect(engine.isPlaying()).toBe(false);
    await engine.prepare(info);
    expect(ctx.nodes).toHaveLength(1);
    expect(worker.operations()).not.toContain("stream.start");
    expect(worker.operations()).not.toContain("transport.play");
  });
});
