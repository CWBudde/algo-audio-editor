/**
 * Playback AudioWorklet. It runs on the real-time audio thread and therefore
 * does nothing but copy frames out of the shared ring buffer: no WASM, no
 * allocation, no messaging in process(). The kernel worker keeps the ring
 * filled ahead of time, so a GC pause in Go never reaches the audio thread.
 *
 * Loaded through `?worker&url` so Vite bundles the ring-buffer import into a
 * single self-contained script.
 */
import {
  PLAYBACK_PROCESSOR,
  type PlaybackProcessorOptions,
  STOP_PLAYBACK_PROCESSOR,
} from "./playback-shared";
import { FrameRingBuffer } from "./ring-buffer";

// AudioWorkletGlobalScope is not part of lib.dom; declare the little we use.
declare abstract class AudioWorkletProcessor {
  constructor(options?: AudioWorkletNodeOptions);
  readonly port: MessagePort;
  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
declare function registerProcessor(
  name: string,
  ctor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;
declare const currentFrame: number;

class PlaybackProcessor extends AudioWorkletProcessor {
  private readonly ring: FrameRingBuffer;
  private stopped = false;

  constructor(options: AudioWorkletNodeOptions) {
    super(options);
    const { ring } = options.processorOptions as PlaybackProcessorOptions;
    this.ring = FrameRingBuffer.attach(ring);
    this.port.onmessage = (event: MessageEvent) => {
      if (event.data === STOP_PLAYBACK_PROCESSOR) this.stopped = true;
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.stopped) return false;
    const out = outputs[0];
    if (out.length > 0) {
      this.ring.readPlanar(out, out[0].length, currentFrame);
    }
    return true;
  }
}

registerProcessor(PLAYBACK_PROCESSOR, PlaybackProcessor);
