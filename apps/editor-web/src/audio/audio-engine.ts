import type { KernelClient } from "@/kernel/client";
import { PLAYBACK_PROCESSOR, type PlaybackProcessorOptions } from "./playback-shared";
import workletUrl from "./playback-worklet.ts?worker&url";
import { FrameRingBuffer, type RingBufferStats } from "./ring-buffer";

/** ~170 ms at 48 kHz: enough headroom to ride out a kernel GC pause. */
const RING_CAPACITY_FRAMES = 8192;
const CHANNELS = 2;

/**
 * Owns the AudioContext and the playback graph:
 *
 *   kernel worker ──(SharedArrayBuffer ring)──▶ playback worklet ──▶ destination
 *
 * Starting is ordered so playback never begins on an empty ring: the context
 * stays suspended until the worker reports the ring full.
 */
export class AudioEngine {
  private readonly kernel: KernelClient;
  private ctx: AudioContext | undefined;
  private ring: FrameRingBuffer | undefined;
  private setup: Promise<void> | undefined;

  constructor(kernel: KernelClient) {
    this.kernel = kernel;
  }

  get sampleRate(): number | undefined {
    return this.ctx?.sampleRate;
  }

  async play(): Promise<void> {
    await this.ensureSetup();
    await this.kernel.startStream();
    await this.ctx?.resume();
  }

  async stop(): Promise<void> {
    if (!this.ctx || !this.ring) return;
    await this.ctx.suspend();
    await this.kernel.stopStream();
    // Both sides are idle now, so the ring can be emptied safely.
    this.ring.reset();
  }

  stats(): RingBufferStats | undefined {
    return this.ring?.stats();
  }

  async dispose(): Promise<void> {
    await this.stop();
    await this.ctx?.close();
    this.ctx = undefined;
    this.ring = undefined;
    this.setup = undefined;
  }

  private ensureSetup(): Promise<void> {
    // The context is created synchronously so it is still inside the user
    // gesture that triggered play(); browsers refuse to start audio otherwise.
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: "interactive" });
    }
    const ctx = this.ctx;

    this.setup ??= (async () => {
      await ctx.suspend();
      await this.kernel.call("engine.configure", {
        sampleRate: ctx.sampleRate,
        channels: CHANNELS,
      });
      await ctx.audioWorklet.addModule(workletUrl);

      const ring = FrameRingBuffer.create(RING_CAPACITY_FRAMES, CHANNELS);
      await this.kernel.attachStream(ring.init);

      const processorOptions: PlaybackProcessorOptions = { ring: ring.init };
      const node = new AudioWorkletNode(ctx, PLAYBACK_PROCESSOR, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [CHANNELS],
        processorOptions,
      });
      node.connect(ctx.destination);
      this.ring = ring;
    })().catch((err: unknown) => {
      this.setup = undefined;
      throw err;
    });
    return this.setup;
  }
}
