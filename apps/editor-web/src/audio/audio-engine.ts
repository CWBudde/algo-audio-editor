import type { DocumentInfoResult, TransportPlayParams } from "@aae/protocol";
import type { KernelClient } from "@/kernel/client";
import {
  PLAYBACK_PROCESSOR,
  type PlaybackProcessorOptions,
  STOP_PLAYBACK_PROCESSOR,
} from "./playback-shared";
import workletUrl from "./playback-worklet.ts?worker&url";
import { FrameRingBuffer, type RingBufferStats } from "./ring-buffer";

const RING_CAPACITY_FRAMES = 8192;
const OUTPUT_LATENCY_HINT_SECONDS = 0.001;
// Device callbacks can drain several 128-frame quanta together. At 48 kHz this
// rounded horizon holds 768 frames: a 512-frame burst and 256 frames of headroom.
// Refills and control processing must finish before that headroom is consumed.
const EFFECT_PREVIEW_BUFFER_SECONDS = 0.016;

/** The worklet only copies; browser speaker routing handles document channels. */
export class AudioEngine {
  private readonly kernel: KernelClient;
  private ctx: AudioContext | undefined;
  private node: AudioWorkletNode | undefined;
  private ring: FrameRingBuffer | undefined;
  private setup: Promise<void> | undefined;
  private module: Promise<void> | undefined;
  private resume: Promise<void> | undefined;
  private fence: Promise<void> = Promise.resolve();
  private generation = 0;
  private playing = false;
  private cursor = 0;
  private audibleCursor = 0;
  private info: DocumentInfoResult | undefined;
  private params: TransportPlayParams | undefined;
  private transportStarted = false;

  constructor(kernel: KernelClient) {
    this.kernel = kernel;
  }

  get sampleRate(): number | undefined {
    return this.ctx?.sampleRate;
  }

  /** Unlock under the Preview gesture, then leave a configured, silent graph. */
  async prepare(info: DocumentInfoResult): Promise<void> {
    this.cursor = this.position();
    this.audibleCursor = this.cursor;
    const generation = ++this.generation;
    this.playing = false;
    try {
      this.ctx ??= new AudioContext({ latencyHint: OUTPUT_LATENCY_HINT_SECONDS });
      // Unlike a resume after processing, this call still has user activation.
      const unlock = this.ctx.resume();
      this.resume = unlock;
      void unlock.catch(() => {});
      await this.enqueue(async () => {
        await unlock;
        if (generation !== this.generation) return;
        await this.ensureSetup(info.channels, generation);
        if (generation !== this.generation) return;
        await this.quiet();
        if (generation !== this.generation) return;
        await this.kernel.call("transport.stop");
        if (generation !== this.generation) return;
        this.transportStarted = false;
        this.info = info;
        this.ring?.reset(this.cursor);
      });
    } catch (error) {
      if (generation === this.generation) await this.stop().catch(() => {});
      throw error;
    }
  }

  async play(info: DocumentInfoResult, params: TransportPlayParams): Promise<void> {
    const generation = ++this.generation;
    this.playing = true;
    this.info = info;
    this.params = { ...params };
    this.transportStarted = false;
    // Must happen synchronously under the caller's browser user gesture.
    try {
      this.ctx ??= new AudioContext({ latencyHint: OUTPUT_LATENCY_HINT_SECONDS });
      await this.enqueue(async () => {
        if (generation !== this.generation) return;
        await this.ensureSetup(info.channels, generation);
        if (generation !== this.generation) return;
        await this.quiet();
        if (generation !== this.generation) return;
        this.ring?.reset(params.start);
        this.cursor = params.start;
        this.audibleCursor = params.start;
        await this.kernel.call("transport.play", params);
        if (generation !== this.generation) return;
        this.transportStarted = true;
        await this.kernel.startStream(
          this.params?.effectPreviewId && this.ctx
            ? Math.min(
                RING_CAPACITY_FRAMES - 1,
                Math.ceil((this.ctx.sampleRate * EFFECT_PREVIEW_BUFFER_SECONDS) / 128) * 128,
              )
            : undefined,
        );
        if (generation !== this.generation) return;
        this.resume = this.ctx?.resume();
        await this.resume;
      });
    } catch (error) {
      if (generation === this.generation) await this.stop().catch(() => {});
      throw error;
    }
  }

  stop(): Promise<void> {
    // Preserve the user's audible gesture position, not the worklet's ahead-of-
    // device cursor after asynchronous suspension drains queued output.
    this.cursor = this.position();
    this.audibleCursor = this.cursor;
    ++this.generation;
    this.playing = false;
    return this.enqueue(async () => {
      await this.setup?.catch(() => {});
      try {
        await this.quiet();
      } finally {
        await this.kernel.call("transport.stop");
        this.transportStarted = false;
      }
      this.ring?.reset(this.cursor);
    });
  }

  seek(frame: number): Promise<void> {
    const generation = ++this.generation;
    const wasPlaying = this.playing && !this.ended();
    const pending = this.enqueue(async () => {
      await this.setup?.catch(() => {});
      if (generation !== this.generation) return;
      if (wasPlaying && this.info) await this.ensureSetup(this.info.channels, generation);
      if (generation !== this.generation) return;
      await this.quiet();
      if (generation !== this.generation) return;
      if (wasPlaying && !this.transportStarted && this.params && frame < (this.info?.frames ?? 0)) {
        await this.kernel.call("transport.play", this.params);
        if (generation !== this.generation) return;
        this.transportStarted = true;
      }
      const result = await this.kernel.call("transport.seek", { frame });
      if (generation !== this.generation) return;
      this.cursor = result.position;
      this.audibleCursor = result.position;
      this.ring?.reset(result.position);
      this.playing = wasPlaying && result.playing;
      if (!this.playing) return;
      await this.kernel.startStream(
        this.params?.effectPreviewId && this.ctx
          ? Math.min(
              RING_CAPACITY_FRAMES - 1,
              Math.ceil((this.ctx.sampleRate * EFFECT_PREVIEW_BUFFER_SECONDS) / 128) * 128,
            )
          : undefined,
      );
      if (generation !== this.generation) return;
      this.resume = this.ctx?.resume();
      await this.resume;
    });
    return pending.catch(async (error: unknown) => {
      if (generation === this.generation) await this.stop().catch(() => {});
      throw error;
    });
  }

  position(): number {
    if (!this.playing) return this.cursor;
    const frame = this.outputFrame();
    if (frame === undefined) return this.ring?.stats().documentFrame ?? this.cursor;
    this.audibleCursor = this.ring?.audiblePosition(frame) ?? this.audibleCursor;
    return this.audibleCursor;
  }

  ended(): boolean {
    const frame = this.outputFrame();
    return (
      (frame === undefined ? this.ring?.stats().ended : this.ring?.audibleEnded(frame)) ?? false
    );
  }

  isPlaying(): boolean {
    return this.playing && !this.ended();
  }

  stats(): RingBufferStats | undefined {
    return this.ring?.stats();
  }

  async dispose(): Promise<void> {
    try {
      await this.stop();
    } finally {
      // A fatal processing watchdog has already killed the worker. Its stop
      // RPC may reject, but browser resources must still be released.
      try {
        this.releaseNode();
      } finally {
        try {
          await this.ctx?.close();
        } finally {
          this.ctx = undefined;
          this.node = undefined;
          this.ring = undefined;
          this.setup = undefined;
          this.module = undefined;
          this.resume = undefined;
          this.transportStarted = false;
        }
      }
    }
  }

  private releaseNode(): void {
    if (!this.node) return;
    this.node.port.postMessage(STOP_PLAYBACK_PROCESSOR);
    this.node.disconnect();
    this.node = undefined;
    this.ring = undefined;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = this.fence.catch(() => {}).then(operation);
    this.fence = pending;
    return pending;
  }

  private async quiet(): Promise<void> {
    // A late resume must settle before suspend, or it could revive stale audio.
    await this.resume?.catch(() => {});
    try {
      await this.ctx?.suspend();
    } finally {
      await this.kernel.stopStream();
    }
  }

  private async ensureSetup(channels: number, generation: number): Promise<void> {
    await this.setup;
    if (generation !== this.generation) return;
    if (this.ring?.channels === channels) return;
    const ctx = this.ctx;
    if (!ctx) throw new Error("audio context unavailable");
    this.setup = (async () => {
      await this.quiet();
      this.releaseNode();
      await this.kernel.call("engine.configure", { sampleRate: ctx.sampleRate, channels });
      this.module ??= ctx.audioWorklet.addModule(workletUrl);
      await this.module;
      const ring = FrameRingBuffer.create(
        RING_CAPACITY_FRAMES,
        channels,
        Math.ceil(ctx.sampleRate) + 256,
      );
      await this.kernel.attachStream(ring.init);
      const processorOptions: PlaybackProcessorOptions = { ring: ring.init };
      const node = new AudioWorkletNode(ctx, PLAYBACK_PROCESSOR, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [channels],
        channelCount: channels,
        channelCountMode: "explicit",
        processorOptions,
      });
      node.connect(ctx.destination);
      this.node = node;
      this.ring = ring;
    })();
    try {
      await this.setup;
    } catch (error) {
      this.module = undefined;
      throw error;
    } finally {
      this.setup = undefined;
    }
  }

  private outputFrame(): number | undefined {
    const ctx = this.ctx;
    if (!ctx?.getOutputTimestamp) return undefined;
    const timestamp = ctx.getOutputTimestamp();
    if (
      timestamp.contextTime === undefined ||
      !Number.isFinite(timestamp.contextTime) ||
      timestamp.contextTime < 0
    )
      return undefined;
    // Zero/zero is the browser's startup sentinel, not an audible stream clock.
    const elapsed =
      timestamp.performanceTime &&
      Number.isFinite(timestamp.performanceTime) &&
      ctx.state === "running"
        ? Math.max(0, performance.now() - timestamp.performanceTime) / 1000
        : 0;
    return (timestamp.contextTime + elapsed) * ctx.sampleRate;
  }
}
