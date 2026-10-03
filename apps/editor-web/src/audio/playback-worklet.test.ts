import { afterEach, describe, expect, it, vi } from "vitest";
import { FrameRingBuffer } from "./ring-buffer";

type Processor = { process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean };

async function processor(ring: FrameRingBuffer) {
  vi.resetModules();
  let Constructor: (new (options: AudioWorkletNodeOptions) => Processor) | undefined;
  vi.stubGlobal("AudioWorkletProcessor", class {});
  vi.stubGlobal("registerProcessor", (_name: string, ctor: typeof Constructor) => {
    Constructor = ctor;
  });
  await import("./playback-worklet");
  if (!Constructor) throw new Error("processor not registered");
  return new Constructor({ processorOptions: { ring: ring.init } });
}

afterEach(() => vi.unstubAllGlobals());

describe("PlaybackProcessor", () => {
  it("copies channels and cursor history, drains EOF silence without underruns or messages", async () => {
    const ring = FrameRingBuffer.create(8, 2, 256);
    ring.write(Float32Array.from([0.25, -0.25, 0.5, -0.5]), 2, BigInt64Array.from([41n, 42n]));
    ring.markEnd();
    const worklet = await processor(ring);
    const messages = vi.fn();
    vi.stubGlobal("postMessage", messages);
    vi.stubGlobal("currentFrame", 100);
    const outputs = [[new Float32Array(128), new Float32Array(128)]];
    expect(worklet.process([], outputs)).toBe(true);
    expect(Array.from(outputs[0][0].slice(0, 4))).toEqual([0.25, 0.5, 0, 0]);
    expect(Array.from(outputs[0][1].slice(0, 4))).toEqual([-0.25, -0.5, 0, 0]);
    expect(ring.audiblePosition(100)).toBe(41);
    expect(ring.audiblePosition(101)).toBe(42);
    expect(ring.audibleEnded(101)).toBe(false);
    expect(ring.audibleEnded(102)).toBe(true);
    expect(ring.stats()).toMatchObject({
      consumedFrames: 2,
      documentFrame: 42,
      ended: true,
      underrunFrames: 0,
    });
    vi.stubGlobal("currentFrame", 228);
    worklet.process([], outputs);
    expect(ring.stats().underrunFrames).toBe(0);
    expect(messages).not.toHaveBeenCalled();
  });

  it("copies tag words exactly beyond 32 bits and at maximum JS-safe cursor", async () => {
    const ring = FrameRingBuffer.create(8, 1, 256);
    ring.write(new Float32Array(2), 2, BigInt64Array.from([4294967296n, 9007199254740991n]));
    const worklet = await processor(ring);
    vi.stubGlobal("currentFrame", 4294967296);
    worklet.process([], [[new Float32Array(2)]]);
    expect(ring.audiblePosition(4294967296)).toBe(4294967296);
    expect(ring.audiblePosition(4294967297)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("accepts an output-less quantum without consuming the ring", async () => {
    const ring = FrameRingBuffer.create(8, 1);
    ring.write(new Float32Array(2), 2, BigInt64Array.from([1n, 2n]));
    const worklet = await processor(ring);
    expect(worklet.process([], [[]])).toBe(true);
    expect(ring.availableRead()).toBe(2);
  });
});
