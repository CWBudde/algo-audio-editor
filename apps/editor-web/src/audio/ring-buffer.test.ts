import { describe, expect, it, vi } from "vitest";
import { FrameRingBuffer } from "./ring-buffer";

/** Interleaved frames whose samples encode (frame index, channel). */
function frames(start: number, count: number, channels: number): Float32Array {
  const out = new Float32Array(count * channels);
  for (let f = 0; f < count; f++) {
    for (let c = 0; c < channels; c++) {
      out[f * channels + c] = (start + f) * 10 + c;
    }
  }
  return out;
}

function planar(channels: number, length: number): Float32Array[] {
  return Array.from({ length: channels }, () => new Float32Array(length));
}

describe("FrameRingBuffer", () => {
  it("holds capacity - 1 frames", () => {
    const ring = FrameRingBuffer.create(8, 2);
    expect(ring.availableWrite()).toBe(7);
    expect(ring.write(frames(0, 10, 2), 10)).toBe(7);
    expect(ring.availableRead()).toBe(7);
    expect(ring.availableWrite()).toBe(0);
    expect(ring.write(frames(7, 1, 2), 1)).toBe(0);
  });

  it("de-interleaves into planar outputs", () => {
    const ring = FrameRingBuffer.create(16, 2);
    ring.write(frames(0, 4, 2), 4);

    const out = planar(2, 4);
    expect(ring.readPlanar(out, 4)).toBe(4);
    expect(Array.from(out[0])).toEqual([0, 10, 20, 30]);
    expect(Array.from(out[1])).toEqual([1, 11, 21, 31]);
  });

  it("preserves order across the wrap point", () => {
    const ring = FrameRingBuffer.create(5, 1);
    const out = planar(1, 3);
    let next = 0;
    const seen: number[] = [];

    // Interleave writes and reads so the indices wrap several times.
    for (let round = 0; round < 6; round++) {
      next += ring.write(frames(next, 3, 1), 3);
      const n = ring.readPlanar(out, 3);
      seen.push(...Array.from(out[0].subarray(0, n)));
    }

    expect(seen).toEqual(Array.from({ length: seen.length }, (_, i) => i * 10));
    expect(ring.stats().underrunFrames).toBe(0);
  });

  it("zero-fills and counts underruns", () => {
    const ring = FrameRingBuffer.create(8, 1);
    ring.write(frames(1, 2, 1), 2);

    const out = planar(1, 5);
    out[0].fill(99);
    expect(ring.readPlanar(out, 5)).toBe(2);
    expect(Array.from(out[0])).toEqual([10, 20, 0, 0, 0]);
    expect(ring.stats()).toEqual({
      underrunFrames: 3,
      consumedFrames: 2,
      bufferedFrames: 0,
      documentFrame: 0,
      ended: false,
    });
  });

  it("repeats the last ring channel into extra output channels", () => {
    const ring = FrameRingBuffer.create(8, 1);
    ring.write(frames(1, 2, 1), 2);

    const out = planar(2, 2);
    ring.readPlanar(out, 2);
    expect(Array.from(out[1])).toEqual(Array.from(out[0]));
  });

  it("shares state between attached views", () => {
    const producer = FrameRingBuffer.create(8, 2);
    const consumer = FrameRingBuffer.attach(producer.init);
    producer.write(frames(0, 3, 2), 3);
    expect(consumer.availableRead()).toBe(3);

    consumer.readPlanar(planar(2, 3), 3);
    expect(producer.availableWrite()).toBe(7);
  });

  it("reset clears data indices and counters", () => {
    const ring = FrameRingBuffer.create(8, 1);
    ring.write(frames(0, 3, 1), 3);
    ring.readPlanar(planar(1, 5), 5);
    ring.reset();
    expect(ring.stats()).toEqual({
      underrunFrames: 0,
      consumedFrames: 0,
      bufferedFrames: 0,
      documentFrame: 0,
      ended: false,
    });
  });

  it("rejects invalid layouts", () => {
    expect(() => FrameRingBuffer.create(1, 2)).toThrow(RangeError);
    expect(() => FrameRingBuffer.create(8, 0)).toThrow(RangeError);
    expect(() =>
      FrameRingBuffer.attach({ sab: new SharedArrayBuffer(16), channels: 2, capacityFrames: 8 }),
    ).toThrow(RangeError);
  });

  it("publishes consumed cursor tags across loop boundaries and ring wrapping", () => {
    const ring = FrameRingBuffer.create(5, 1);
    ring.write(frames(0, 3, 1), 3, BigInt64Array.from([11n, 12n, 10n]));
    ring.readPlanar(planar(1, 2), 2);
    expect(ring.stats().documentFrame).toBe(12);
    ring.write(frames(3, 3, 1), 3, BigInt64Array.from([11n, 12n, 10n]));
    ring.readPlanar(planar(1, 4), 4);
    expect(ring.stats().documentFrame).toBe(10);
    expect(ring.stats().consumedFrames).toBe(6);
  });

  it("keeps 64-bit consumed count monotonic beyond signed and unsigned 32-bit limits", () => {
    const ring = FrameRingBuffer.create(8, 1);
    const counters = new BigInt64Array(ring.init.sab, 16, 2);
    Atomics.store(counters, 0, 4294967295n);
    ring.write(frames(0, 2, 1), 2, BigInt64Array.from([2147483648n, 2147483649n]));
    ring.readPlanar(planar(1, 2), 2);
    expect(ring.stats().consumedFrames).toBe(4294967297);
    expect(ring.stats().documentFrame).toBe(2147483649);
    expect(Atomics.load(counters, 0)).toBe(4294967297n);
  });

  it("marks EOF only after draining and does not count tail silence as underruns", () => {
    const ring = FrameRingBuffer.create(8, 1);
    ring.reset(37);
    ring.write(frames(0, 2, 1), 2, BigInt64Array.from([38n, 39n]));
    ring.markEnd();
    expect(ring.stats().ended).toBe(false);
    const output = planar(1, 5);
    ring.readPlanar(output, 5);
    expect(Array.from(output[0])).toEqual([0, 10, 0, 0, 0]);
    expect(ring.stats()).toEqual({
      bufferedFrames: 0,
      consumedFrames: 2,
      documentFrame: 39,
      ended: true,
      underrunFrames: 0,
    });
    ring.readPlanar(output, 5);
    expect(ring.stats().consumedFrames).toBe(2);
    expect(ring.stats().underrunFrames).toBe(0);
    ring.reset(12);
    expect(ring.stats().ended).toBe(false);
    expect(ring.stats().documentFrame).toBe(12);
  });

  it("retains audible cursor history across loops, producer overwrite and history wrap", () => {
    const ring = FrameRingBuffer.create(5, 1, 6);
    ring.reset(10);
    ring.write(frames(0, 4, 1), 4, BigInt64Array.from([11n, 12n, 10n, 11n]));
    ring.readPlanar(planar(1, 4), 4, 100);
    expect(ring.audiblePosition(0)).toBe(10);
    expect(ring.audiblePosition(100)).toBe(11);
    expect(ring.audiblePosition(101)).toBe(12);
    expect(ring.audiblePosition(102)).toBe(10);
    ring.write(frames(4, 4, 1), 4, BigInt64Array.from([12n, 10n, 11n, 12n]));
    expect(ring.audiblePosition(102)).toBe(10);
    ring.readPlanar(planar(1, 4), 4, 104);
    expect(ring.audiblePosition(102)).toBe(10);
    expect(ring.audiblePosition(105)).toBe(10);
    expect(ring.audiblePosition(1000)).toBe(12);
  });

  it("waits for audible EOF instead of reporting the quantum's ahead-of-device cursor", () => {
    const ring = FrameRingBuffer.create(8, 1, 16);
    ring.reset(37);
    ring.write(frames(0, 2, 1), 2, BigInt64Array.from([38n, 39n]));
    ring.markEnd();
    ring.readPlanar(planar(1, 8), 8, 100);
    expect(ring.stats().ended).toBe(true);
    expect(ring.audibleEnded(101)).toBe(false);
    expect(ring.audibleEnded(102)).toBe(true);
    expect(ring.audiblePosition(104)).toBe(39);
    ring.readPlanar(planar(1, 8), 8, 108);
    expect(ring.audibleEnded(103)).toBe(true);
    ring.reset(500);
    expect(ring.audiblePosition(103)).toBe(500);
    expect(ring.audibleEnded(103)).toBe(false);
  });

  it("bounds main-thread seqlock retries and returns the last coherent statistics", () => {
    const ring = FrameRingBuffer.create(8, 1);
    ring.write(frames(0, 2, 1), 2, BigInt64Array.from([1n, 2n]));
    ring.readPlanar(planar(1, 2), 2, 0);
    const stats = ring.stats();
    const counters = new BigInt64Array(ring.init.sab, 16, 8);
    Atomics.store(counters, 5, 3n);
    expect(ring.audiblePosition(1)).toBeUndefined();
    expect(ring.stats()).toBe(stats);
  });
});

it("rejects a cursor history read overlapping a split-word overwrite", () => {
  const ring = FrameRingBuffer.create(8, 1, 4);
  ring.write(new Float32Array(2), 2, BigInt64Array.from([4294967306n, 4294967307n]));
  ring.readPlanar([new Float32Array(2)], 2, 0);
  const counters = new Uint32Array(ring.init.sab, 16, 20);
  const history = new Uint32Array(ring.init.sab, 16 + 80 + 8 * 8, 8);
  const load = Atomics.load;
  const spy = vi.spyOn(Atomics, "load").mockImplementation(((
    array: BigInt64Array,
    index: number,
  ) => {
    if (array instanceof BigInt64Array && array.length === 4) {
      Atomics.add(counters, 10, 1);
      history[index * 2] = 99;
    }
    return load(array, index);
  }) as typeof Atomics.load);
  try {
    expect(ring.audiblePosition(1)).toBeUndefined();
  } finally {
    spy.mockRestore();
  }
  history[3] = 2;
  Atomics.add(counters, 10, 1);
  expect(ring.audiblePosition(1)).toBe(8589934691);
});
