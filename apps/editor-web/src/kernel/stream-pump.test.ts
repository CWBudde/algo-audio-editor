import type { KernelBridge } from "@aae/protocol";
import { describe, expect, it, vi } from "vitest";
import { FrameRingBuffer } from "@/audio/ring-buffer";
import { StreamPump, withStreamRefill } from "./stream-pump";

function fixture(length: number) {
  let position = 0;
  const render = vi.fn((bytes: Uint8Array, requested: number, tags?: Uint8Array) => {
    const count = Math.min(requested, length - position);
    const samples = new Float32Array(bytes.buffer);
    const positions = new BigInt64Array(tags?.buffer ?? new ArrayBuffer(0));
    for (let frame = 0; frame < count; frame++) {
      samples[frame] = position;
      positions[frame] = BigInt(++position);
    }
    return count;
  });
  return { kernel: { render } as unknown as KernelBridge, render };
}

describe("StreamPump", () => {
  it("writes a short file before confirming normal EOF and preserves final cursor", () => {
    const ring = FrameRingBuffer.create(8192, 1);
    const { kernel, render } = fixture(17);
    const pump = new StreamPump(ring);
    expect(pump.intervalMs).toBe(10);
    pump.fill(kernel);
    expect(render.mock.calls.map((call) => call[1])).toEqual([512, 512]);
    expect(pump.ended).toBe(true);
    expect(ring.stats().bufferedFrames).toBe(17);
    const out = [new Float32Array(128)];
    ring.readPlanar(out, 128);
    expect(Array.from(out[0].slice(0, 17))).toEqual(Array.from({ length: 17 }, (_, i) => i));
    expect(ring.stats()).toMatchObject({
      consumedFrames: 17,
      documentFrame: 17,
      ended: true,
      underrunFrames: 0,
    });
    pump.fill(kernel);
    expect(render).toHaveBeenCalledTimes(2);
    expect(render.mock.calls[0][0]).toBe(render.mock.calls[1][0]);
    expect(render.mock.calls[0][2]).toBe(render.mock.calls[1][2]);
  });

  it("fills every available slot including a partial final block and drains EOF later", () => {
    const ring = FrameRingBuffer.create(600, 1);
    const { kernel, render } = fixture(700);
    const pump = new StreamPump(ring);
    pump.fill(kernel);
    expect(render.mock.calls.map((call) => call[1])).toEqual([512, 87]);
    expect(ring.availableRead()).toBe(599);
    expect(pump.ended).toBe(false);
    ring.readPlanar([new Float32Array(599)], 599);
    pump.fill(kernel);
    expect(ring.availableRead()).toBe(101);
    expect(pump.ended).toBe(true);
    ring.readPlanar([new Float32Array(128)], 128);
    expect(ring.stats()).toMatchObject({
      documentFrame: 700,
      consumedFrames: 700,
      ended: true,
      underrunFrames: 0,
    });
  });

  it("accepts zero-frame documents as normal EOF", () => {
    const ring = FrameRingBuffer.create(8, 1);
    const pump = new StreamPump(ring);
    pump.fill(fixture(0).kernel);
    expect(ring.stats().ended).toBe(true);
  });

  it.each([-1, 513, 1.5, Number.NaN])(
    "rejects invalid render counts %s without publishing them",
    (count) => {
      const ring = FrameRingBuffer.create(8192, 1);
      const pump = new StreamPump(ring);
      expect(() => pump.fill({ render: () => count } as unknown as KernelBridge)).toThrow(
        "kernel render failed",
      );
      expect(ring.stats()).toMatchObject({ bufferedFrames: 0, ended: false });
    },
  );
});

it("refills before and after live controls while preserving every queued source sample", () => {
  const ring = FrameRingBuffer.create(8192, 1);
  const { kernel } = fixture(5000);
  const pump = new StreamPump(ring, 768);
  const consumed = [new Float32Array(512)];
  const result = withStreamRefill(
    "effects.preview.update",
    () => pump.fill(kernel),
    () => {
      expect(ring.availableRead()).toBe(768);
      ring.readPlanar(consumed, 512);
      return { updated: true };
    },
  );
  expect(result).toEqual({ updated: true });
  expect(ring.availableRead()).toBe(768);
  expect(Array.from(consumed[0])).toEqual(Array.from({ length: 512 }, (_, index) => index));
  const remaining = [new Float32Array(768)];
  ring.readPlanar(remaining, 768);
  expect(Array.from(remaining[0])).toEqual(Array.from({ length: 768 }, (_, index) => index + 512));
  expect(ring.stats().underrunFrames).toBe(0);
});

it("still refills after a rejected control without hiding its error or losing sample order", () => {
  const ring = FrameRingBuffer.create(8192, 1);
  const { kernel } = fixture(5000);
  const pump = new StreamPump(ring, 768);
  expect(() =>
    withStreamRefill(
      "effects.preview.meters",
      () => pump.fill(kernel),
      () => {
        ring.readPlanar([new Float32Array(512)], 512);
        throw new Error("stale preview");
      },
    ),
  ).toThrow("stale preview");
  expect(ring.availableRead()).toBe(768);
  const remaining = [new Float32Array(768)];
  ring.readPlanar(remaining, 768);
  expect(Array.from(remaining[0])).toEqual(Array.from({ length: 768 }, (_, index) => index + 512));
  expect(ring.stats().underrunFrames).toBe(0);
});

it.each([
  "transport.play",
  "transport.seek",
  "transport.stop",
  "engine.configure",
  "effects.preview.stop",
  "process.commit",
])("does not refill around lifecycle method %s or publish premature EOF", (method) => {
  const refill = vi.fn();
  const call = vi.fn(() => "changed stream");
  expect(withStreamRefill(method, refill, call)).toBe("changed stream");
  expect(refill).not.toHaveBeenCalled();
  expect(call).toHaveBeenCalledOnce();
});

it("bounds only preview buffering and tops up drained frames without changing production sample order", () => {
  const ring = FrameRingBuffer.create(8192, 1);
  const { kernel, render } = fixture(5000);
  const pump = new StreamPump(ring, 1024);
  expect(pump.intervalMs).toBe(1);
  pump.fill(kernel);
  expect(ring.availableRead()).toBe(1024);
  expect(render).toHaveBeenCalledTimes(2);
  pump.fill(kernel);
  expect(render).toHaveBeenCalledTimes(2);
  const output = [new Float32Array(128)];
  ring.readPlanar(output, 128);
  pump.fill(kernel);
  expect(ring.availableRead()).toBe(1024);
  expect(render.mock.calls.at(-1)?.[1]).toBe(128);
  expect(Array.from(output[0])).toEqual(Array.from({ length: 128 }, (_, index) => index));
});
