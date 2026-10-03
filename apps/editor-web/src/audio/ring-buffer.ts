/**
 * Single-producer/single-consumer ring buffer of interleaved float32 frames
 * over a SharedArrayBuffer.
 *
 * The kernel worker is the only writer and the playback AudioWorklet the only
 * reader. Each side owns one index and only reads the other's, so plain
 * Atomics.load/store is enough; no compare-and-swap is needed. One slot always
 * stays empty so that read === write unambiguously means "empty".
 *
 * Layout: 16-byte Int32 header, aligned BigInt64 consumed/cursor header,
 * one BigInt64 cursor tag per frame, then interleaved float32 samples.
 */

const HEADER = {
  read: 0,
  write: 1,
  /** Frames the reader had to zero-fill because the buffer ran dry. */
  underrunFrames: 2,
  /** Producer has reached normal end-of-stream. */
  eos: 3,
} as const;

const HEADER_INTS = 4;
const HEADER_BYTES = HEADER_INTS * Int32Array.BYTES_PER_ELEMENT;
const COUNTER_BYTES = 10 * BigInt64Array.BYTES_PER_ELEMENT;
const TAG_OFFSET = HEADER_BYTES + COUNTER_BYTES;
const DEFAULT_HISTORY_FRAMES = 32768;
const COUNTER = {
  consumed: 0,
  cursor: 1,
  historyStart: 2,
  historyEnd: 3,
  finalFrame: 4,
  sequence: 5,
  initialCursor: 6,
  firstContextFrame: 7,
  epoch: 8,
} as const;

/** Everything needed to attach to an existing ring from another thread. */
export interface RingBufferInit {
  sab: SharedArrayBuffer;
  channels: number;
  capacityFrames: number;
  historyFrames?: number;
}

export interface RingBufferStats {
  underrunFrames: number;
  consumedFrames: number;
  bufferedFrames: number;
  documentFrame: number;
  ended: boolean;
}

export class FrameRingBuffer {
  readonly init: RingBufferInit;
  readonly channels: number;
  readonly capacityFrames: number;
  private readonly header: Int32Array;
  private readonly data: Float32Array;
  private readonly counters: BigInt64Array;
  private readonly positions: BigInt64Array;
  private readonly history: BigInt64Array;
  private readonly positionWords: Uint32Array;
  private readonly historyWords: Uint32Array;
  private readonly counterWords: Uint32Array;
  private lastStats: RingBufferStats = {
    underrunFrames: 0,
    consumedFrames: 0,
    bufferedFrames: 0,
    documentFrame: 0,
    ended: false,
  };

  private constructor(init: RingBufferInit) {
    const { sab, channels, capacityFrames } = init;
    if (!Number.isInteger(channels) || channels < 1) {
      throw new RangeError(`channels must be a positive integer, got ${channels}`);
    }
    if (!Number.isInteger(capacityFrames) || capacityFrames < 2) {
      throw new RangeError(`capacityFrames must be an integer >= 2, got ${capacityFrames}`);
    }
    const historyFrames = init.historyFrames ?? DEFAULT_HISTORY_FRAMES;
    if (!Number.isInteger(historyFrames) || historyFrames < 1)
      throw new RangeError("historyFrames must be a positive integer");
    const historyOffset = TAG_OFFSET + capacityFrames * BigInt64Array.BYTES_PER_ELEMENT;
    const sampleOffset = historyOffset + historyFrames * BigInt64Array.BYTES_PER_ELEMENT;
    const needed = sampleOffset + capacityFrames * channels * Float32Array.BYTES_PER_ELEMENT;
    if (sab.byteLength < needed) {
      throw new RangeError(`buffer holds ${sab.byteLength} bytes, layout needs ${needed}`);
    }

    this.init = init;
    this.channels = channels;
    this.capacityFrames = capacityFrames;
    this.header = new Int32Array(sab, 0, HEADER_INTS);
    this.counters = new BigInt64Array(sab, HEADER_BYTES, 10);
    this.positions = new BigInt64Array(sab, TAG_OFFSET, capacityFrames);
    this.history = new BigInt64Array(sab, historyOffset, historyFrames);
    this.positionWords = new Uint32Array(sab, TAG_OFFSET, capacityFrames * 2);
    this.historyWords = new Uint32Array(sab, historyOffset, historyFrames * 2);
    this.counterWords = new Uint32Array(sab, HEADER_BYTES, 20);
    this.data = new Float32Array(sab, sampleOffset, capacityFrames * channels);
  }

  /** Allocates a new ring. It holds at most `capacityFrames - 1` frames. */
  static create(
    capacityFrames: number,
    channels: number,
    historyFrames = DEFAULT_HISTORY_FRAMES,
  ): FrameRingBuffer {
    const bytes =
      TAG_OFFSET +
      capacityFrames *
        (BigInt64Array.BYTES_PER_ELEMENT + channels * Float32Array.BYTES_PER_ELEMENT) +
      historyFrames * BigInt64Array.BYTES_PER_ELEMENT;
    const ring = new FrameRingBuffer({
      sab: new SharedArrayBuffer(bytes),
      channels,
      capacityFrames,
      historyFrames,
    });
    ring.reset();
    return ring;
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
  write(src: Float32Array, frames: number, positions?: BigInt64Array): number {
    const n = Math.min(
      frames,
      this.availableWrite(),
      Math.floor(src.length / this.channels),
      positions?.length ?? frames,
    );
    if (n <= 0) return 0;

    const ch = this.channels;
    const write = Atomics.load(this.header, HEADER.write);
    const first = Math.min(n, this.capacityFrames - write);

    this.data.set(src.subarray(0, first * ch), write * ch);
    if (n > first) {
      this.data.set(src.subarray(first * ch, n * ch), 0);
    }
    for (let i = 0; i < n; i++) {
      this.positions[(write + i) % this.capacityFrames] = positions?.[i] ?? 0n;
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
  readPlanar(outputs: Float32Array[], frames: number, contextFrame?: number): number {
    Atomics.add(this.counters, COUNTER.sequence, 1n);
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

    // Worklet copies timeline tags; producer can safely overwrite drained slots.
    if (contextFrame !== undefined) {
      const lastIndex = ((read + n - 1 + this.capacityFrames) % this.capacityFrames) * 2;
      const lastLow = n > 0 ? this.positionWords[lastIndex] : this.counterWords[COUNTER.cursor * 2];
      const lastHigh =
        n > 0 ? this.positionWords[lastIndex + 1] : this.counterWords[COUNTER.cursor * 2 + 1];
      for (let i = 0; i < frames; i++) {
        const target = ((contextFrame + i) % this.history.length) * 2;
        const source = ((read + i) % this.capacityFrames) * 2;
        this.historyWords[target] = i < n ? this.positionWords[source] : lastLow;
        this.historyWords[target + 1] = i < n ? this.positionWords[source + 1] : lastHigh;
      }
      const end = contextFrame + frames;
      const previousStart = Number(Atomics.load(this.counters, COUNTER.historyStart));
      if (previousStart < 0)
        Atomics.store(this.counters, COUNTER.firstContextFrame, BigInt(contextFrame));
      Atomics.store(
        this.counters,
        COUNTER.historyStart,
        BigInt(
          Math.max(previousStart < 0 ? contextFrame : previousStart, end - this.history.length),
        ),
      );
      Atomics.store(this.counters, COUNTER.historyEnd, BigInt(end));
      if (
        Atomics.load(this.header, HEADER.eos) !== 0 &&
        n === available &&
        Atomics.load(this.counters, COUNTER.finalFrame) < 0n
      ) {
        Atomics.store(this.counters, COUNTER.finalFrame, BigInt(contextFrame + n));
      }
    }
    if (n > 0) {
      Atomics.store(this.counters, 1, this.positions[(read + n - 1) % this.capacityFrames]);
      Atomics.add(this.counters, 0, BigInt(n));
    }
    Atomics.store(this.header, HEADER.read, (read + n) % this.capacityFrames);
    if (n < frames && Atomics.load(this.header, HEADER.eos) === 0) {
      Atomics.add(this.header, HEADER.underrunFrames, frames - n);
    }
    Atomics.add(this.counters, COUNTER.sequence, 1n);
    return n;
  }

  stats(): RingBufferStats {
    for (let attempt = 0; attempt < 3; attempt++) {
      const version = Atomics.load(this.counters, COUNTER.sequence);
      if ((version & 1n) !== 0n) continue;
      const bufferedFrames = this.availableRead();
      const snapshot = {
        underrunFrames: Atomics.load(this.header, HEADER.underrunFrames),
        consumedFrames: Number(Atomics.load(this.counters, 0)),
        bufferedFrames,
        documentFrame: Number(Atomics.load(this.counters, 1)),
        ended: Atomics.load(this.header, HEADER.eos) !== 0 && bufferedFrames === 0,
      };
      if (Atomics.load(this.counters, COUNTER.sequence) === version) {
        this.lastStats = snapshot;
        return snapshot;
      }
    }
    return this.lastStats;
  }

  /** Published history remains readable while a later quantum is being copied. */
  audiblePosition(contextFrame: number): number | undefined {
    for (let attempt = 0; attempt < 3; attempt++) {
      const epoch = Atomics.load(this.counters, COUNTER.epoch);
      if ((epoch & 1n) !== 0n) continue;
      const start = Number(Atomics.load(this.counters, COUNTER.historyStart));
      const end = Number(Atomics.load(this.counters, COUNTER.historyEnd));
      const first = Number(Atomics.load(this.counters, COUNTER.firstContextFrame));
      const frame = Math.min(Math.max(start, Math.floor(contextFrame)), end - 1);
      const position =
        start < 0 || contextFrame < first
          ? Atomics.load(this.counters, COUNTER.initialCursor)
          : Atomics.load(this.history, frame % this.history.length);
      if (
        Atomics.load(this.counters, COUNTER.epoch) === epoch &&
        (start < 0 ||
          contextFrame < first ||
          (Number(Atomics.load(this.counters, COUNTER.historyStart)) <= frame &&
            Number(Atomics.load(this.counters, COUNTER.historyEnd)) > frame))
      )
        return Number(position);
    }
    return undefined;
  }

  audibleEnded(contextFrame: number): boolean {
    const final = Atomics.load(this.counters, COUNTER.finalFrame);
    return this.stats().ended && final >= 0n && contextFrame >= Number(final);
  }

  /**
   * Empties the ring and clears the counters. Only safe while neither side is
   * running, e.g. with the AudioContext suspended and the producer stopped.
   */
  reset(documentFrame = 0): void {
    Atomics.add(this.counters, COUNTER.epoch, 1n);
    for (let i = 0; i < HEADER_INTS; i++) {
      Atomics.store(this.header, i, 0);
    }
    Atomics.store(this.counters, COUNTER.consumed, 0n);
    Atomics.store(this.counters, COUNTER.cursor, BigInt(documentFrame));
    Atomics.store(this.counters, COUNTER.historyStart, -1n);
    Atomics.store(this.counters, COUNTER.historyEnd, 0n);
    Atomics.store(this.counters, COUNTER.finalFrame, -1n);
    Atomics.store(this.counters, COUNTER.sequence, 0n);
    Atomics.store(this.counters, COUNTER.initialCursor, BigInt(documentFrame));
    Atomics.store(this.counters, COUNTER.firstContextFrame, -1n);
    this.lastStats = {
      underrunFrames: 0,
      consumedFrames: 0,
      bufferedFrames: 0,
      documentFrame,
      ended: false,
    };
    Atomics.add(this.counters, COUNTER.epoch, 1n);
  }

  /** Producer publishes EOF after its final write; consumer silence is expected. */
  markEnd(): void {
    Atomics.store(this.header, HEADER.eos, 1);
  }
}
