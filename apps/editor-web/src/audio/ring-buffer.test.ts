import { describe, expect, it } from "vitest";
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
    expect(ring.stats()).toEqual({ underrunFrames: 3, consumedFrames: 2, bufferedFrames: 0 });
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
    expect(ring.stats()).toEqual({ underrunFrames: 0, consumedFrames: 0, bufferedFrames: 0 });
  });

  it("rejects invalid layouts", () => {
    expect(() => FrameRingBuffer.create(1, 2)).toThrow(RangeError);
    expect(() => FrameRingBuffer.create(8, 0)).toThrow(RangeError);
    expect(() =>
      FrameRingBuffer.attach({ sab: new SharedArrayBuffer(16), channels: 2, capacityFrames: 8 }),
    ).toThrow(RangeError);
  });
});
