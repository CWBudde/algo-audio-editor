/**
 * Single-producer/single-consumer ring buffer of interleaved float32 frames
 * over a SharedArrayBuffer.
 *
 * The kernel worker is the only writer and the playback AudioWorklet the only
 * reader. Each side owns one index and only reads the other's, so plain
 * Atomics.load/store is enough; no compare-and-swap is needed. One slot always
 * stays empty so that read === write unambiguously means "empty".
 *
 * Layout: an Int32 header followed by `capacityFrames * channels` float32s.
 */

const HEADER = {
  read: 0,
  write: 1,
  /** Frames the reader had to zero-fill because the buffer ran dry. */
  underrunFrames: 2,
  /** Frames the reader has consumed in total (wraps after ~12 h at 48 kHz). */
  consumedFrames: 3,
} as const;

const HEADER_INTS = 4;
const HEADER_BYTES = HEADER_INTS * Int32Array.BYTES_PER_ELEMENT;

/** Everything needed to attach to an existing ring from another thread. */
export interface RingBufferInit {
  sab: SharedArrayBuffer;
  channels: number;
  capacityFrames: number;
}

export interface RingBufferStats {
  underrunFrames: number;
  consumedFrames: number;
  bufferedFrames: number;
}

export class FrameRingBuffer {
  readonly init: RingBufferInit;
  readonly channels: number;
  readonly capacityFrames: number;
  private readonly header: Int32Array;
  private readonly data: Float32Array;

  private constructor(init: RingBufferInit) {
    const { sab, channels, capacityFrames } = init;
    if (!Number.isInteger(channels) || channels < 1) {
      throw new RangeError(`channels must be a positive integer, got ${channels}`);
    }
    if (!Number.isInteger(capacityFrames) || capacityFrames < 2) {
      throw new RangeError(`capacityFrames must be an integer >= 2, got ${capacityFrames}`);
    }
    const needed = HEADER_BYTES + capacityFrames * channels * Float32Array.BYTES_PER_ELEMENT;
    if (sab.byteLength < needed) {
      throw new RangeError(`buffer holds ${sab.byteLength} bytes, layout needs ${needed}`);
    }

    this.init = init;
    this.channels = channels;
    this.capacityFrames = capacityFrames;
    this.header = new Int32Array(sab, 0, HEADER_INTS);
    this.data = new Float32Array(sab, HEADER_BYTES, capacityFrames * channels);
  }

  /** Allocates a new ring. It holds at most `capacityFrames - 1` frames. */
  static create(capacityFrames: number, channels: number): FrameRingBuffer {
    const bytes = HEADER_BYTES + capacityFrames * channels * Float32Array.BYTES_PER_ELEMENT;
    return new FrameRingBuffer({ sab: new SharedArrayBuffer(bytes), channels, capacityFrames });
  }

  /** Attaches to a ring created elsewhere, typically on another thread. */
  static attach(init: RingBufferInit): FrameRingBuffer {
    return new FrameRingBuffer(init);
  }

  availableRead(): number {
    const read = Atomics.load(this.header, HEADER.read);
    const write = Atomics.load(this.header, HEADER.write);
    return (write - read + this.capacityFrames) % this.capacityFrames;
  }

  availableWrite(): number {
    return this.capacityFrames - 1 - this.availableRead();
  }

  /**
   * Producer side. Copies up to `frames` interleaved frames from `src` and
   * returns how many fit.
   */
  write(src: Float32Array, frames: number): number {
    const n = Math.min(frames, this.availableWrite(), Math.floor(src.length / this.channels));
    if (n <= 0) return 0;

    const ch = this.channels;
    const write = Atomics.load(this.header, HEADER.write);
    const first = Math.min(n, this.capacityFrames - write);

    this.data.set(src.subarray(0, first * ch), write * ch);
    if (n > first) {
      this.data.set(src.subarray(first * ch, n * ch), 0);
    }

    // Publish only after the samples are in place.
    Atomics.store(this.header, HEADER.write, (write + n) % this.capacityFrames);
    return n;
  }

  /**
   * Consumer side. De-interleaves `frames` frames into the planar `outputs`
   * (one array per output channel, as an AudioWorklet provides them). If the
   * ring runs dry the remainder is zero-filled and counted as an underrun.
   * Output channels beyond the ring's channel count repeat its last channel.
   * Returns the number of frames actually read.
   */
  readPlanar(outputs: Float32Array[], frames: number): number {
    const available = this.availableRead();
    const n = Math.min(frames, available);
    const ch = this.channels;
    const read = Atomics.load(this.header, HEADER.read);

    for (let c = 0; c < outputs.length; c++) {
      const out = outputs[c];
      const src = Math.min(c, ch - 1);
      let pos = read;
      for (let i = 0; i < n; i++) {
        out[i] = this.data[pos * ch + src];
        pos++;
        if (pos === this.capacityFrames) pos = 0;
      }
      out.fill(0, n, frames);
    }

    Atomics.store(this.header, HEADER.read, (read + n) % this.capacityFrames);
    Atomics.add(this.header, HEADER.consumedFrames, n);
    if (n < frames) {
      Atomics.add(this.header, HEADER.underrunFrames, frames - n);
    }
    return n;
  }

  stats(): RingBufferStats {
    return {
      underrunFrames: Atomics.load(this.header, HEADER.underrunFrames),
      consumedFrames: Atomics.load(this.header, HEADER.consumedFrames),
      bufferedFrames: this.availableRead(),
    };
  }

  /**
   * Empties the ring and clears the counters. Only safe while neither side is
   * running, e.g. with the AudioContext suspended and the producer stopped.
   */
  reset(): void {
    for (let i = 0; i < HEADER_INTS; i++) {
      Atomics.store(this.header, i, 0);
    }
  }
}
