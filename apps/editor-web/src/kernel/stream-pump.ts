import type { KernelBridge } from "@aae/protocol";
import type { FrameRingBuffer } from "@/audio/ring-buffer";

export const PUMP_BLOCK_FRAMES = 512;

/** Worker-local reusable scratch. This class never runs on the audio thread. */
export class StreamPump {
  private readonly bytes: Uint8Array;
  private readonly samples: Float32Array;
  private readonly positionBytes: Uint8Array;
  private readonly positions: BigInt64Array;
  ended = false;

  constructor(privateRing: FrameRingBuffer) {
    this.ring = privateRing;
    this.bytes = new Uint8Array(PUMP_BLOCK_FRAMES * privateRing.channels * 4);
    this.samples = new Float32Array(this.bytes.buffer);
    this.positionBytes = new Uint8Array(PUMP_BLOCK_FRAMES * 8);
    this.positions = new BigInt64Array(this.positionBytes.buffer);
  }

  private readonly ring: FrameRingBuffer;

  fill(kernel: KernelBridge): void {
    if (this.ended) return;
    while (this.ring.availableWrite() > 0) {
      const requested = Math.min(PUMP_BLOCK_FRAMES, this.ring.availableWrite());
      const frames = kernel.render(this.bytes, requested, this.positionBytes);
      if (!Number.isInteger(frames) || frames < 0 || frames > requested) {
        throw new Error(`kernel render failed (${frames})`);
      }
      if (frames === 0) {
        this.ended = true;
        this.ring.markEnd();
        return;
      }
      this.ring.write(this.samples, frames, this.positions);
      // A short block is copied first, then the next call confirms EOF.
    }
  }
}
