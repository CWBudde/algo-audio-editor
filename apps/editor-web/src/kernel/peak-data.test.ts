import type { KernelBridge, PeaksGetResult } from "@aae/protocol";
import { describe, expect, it, vi } from "vitest";
import { callKernel } from "./kernel-call";
import { decodePeaks } from "./peak-data";

function fixture(): PeaksGetResult {
  const data = new ArrayBuffer(48);
  new Float32Array(data, 0, 6).set([-0.5, 0.5, 0.25, -0.25, 0.75, 0.5]);
  new Uint32Array(data, 24, 2).set([256, 64]);
  new Float64Array(data, 32, 2).set([1024, 1280]);
  return { count: 2, framesPerBucket: 256, dataBytes: 48, data };
}

function bridgeFor(result: PeaksGetResult): KernelBridge {
  const { data, ...info } = result;
  return {
    call: vi.fn(() => JSON.stringify({ ok: true, result: info })),
    takeData: vi.fn(() => new Uint8Array(data)),
    render: vi.fn(() => 0),
  };
}

describe("decodePeaks", () => {
  it("views kernel-computed values, shortened frame counts and true absolute positions", () => {
    const result = fixture();
    const views = decodePeaks(result);
    expect(Array.from(views.peaks)).toEqual([-0.5, 0.5, 0.25, -0.25, 0.75, 0.5]);
    expect(Array.from(views.frameCounts)).toEqual([256, 64]);
    expect(Array.from(views.startFrames)).toEqual([1024, 1280]);
    expect(views.peaks.buffer).toBe(result.data);
    expect(views.frameCounts.buffer).toBe(result.data);
    expect(views.startFrames.buffer).toBe(result.data);
  });

  it("accepts an empty response", () => {
    const views = decodePeaks({
      count: 0,
      framesPerBucket: 1,
      dataBytes: 0,
      data: new ArrayBuffer(0),
    });
    expect(views.peaks).toHaveLength(0);
    expect(views.frameCounts).toHaveLength(0);
    expect(views.startFrames).toHaveLength(0);
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER, Number.NaN])(
    "rejects invalid bucket count %s",
    (count) => {
      expect(() => decodePeaks({ ...fixture(), count })).toThrow(/bucket count/);
    },
  );

  it.each([0, -1, 0.5, Number.NaN])("rejects invalid frames per bucket %s", (framesPerBucket) => {
    expect(() => decodePeaks({ ...fixture(), framesPerBucket })).toThrow(/frames per bucket/);
  });

  it("rejects truncated data and mismatched metadata", () => {
    expect(() => decodePeaks({ ...fixture(), data: new ArrayBuffer(24) })).toThrow(/length/);
    expect(() => decodePeaks({ ...fixture(), dataBytes: 24 })).toThrow(/length/);
    expect(() => decodePeaks({ ...fixture(), count: 1 })).toThrow(/length/);
  });

  it.each([0, 257])("rejects invalid bucket frame count %i", (frameCount) => {
    const result = fixture();
    new Uint32Array(result.data, 24, 2)[1] = frameCount;
    expect(() => decodePeaks(result)).toThrow(/frame count/);
  });

  it.each([-1, 1024, 1279, Number.NaN, Number.MAX_SAFE_INTEGER])(
    "rejects invalid absolute position %s",
    (start) => {
      const result = fixture();
      new Float64Array(result.data, 32, 2)[1] = start;
      expect(() => decodePeaks(result)).toThrow(/bucket position/);
    },
  );
});

describe("callKernel bulk replies", () => {
  it("takes binary output immediately and transfers the original buffer", () => {
    const result = fixture();
    const bridge = bridgeFor(result);
    const order: string[] = [];
    vi.mocked(bridge.call).mockImplementation(() => {
      order.push("call");
      const { data: _, ...info } = result;
      return JSON.stringify({ ok: true, result: info });
    });
    vi.mocked(bridge.takeData).mockImplementation(() => {
      order.push("takeData");
      return new Uint8Array(result.data);
    });
    const params = { channel: 0, startFrame: 1100, endFrame: 1300, buckets: 1 };
    const reply = callKernel(bridge, "peaks.get", params);
    expect(order).toEqual(["call", "takeData"]);
    expect(bridge.call).toHaveBeenCalledWith("peaks.get", JSON.stringify(params));
    expect(reply.result).toEqual(result);
    expect(reply.transfer).toEqual([result.data]);

    const received = structuredClone(reply.result, { transfer: reply.transfer }) as PeaksGetResult;
    expect(result.data.byteLength).toBe(0);
    expect(Array.from(decodePeaks(received).startFrames)).toEqual([1024, 1280]);
  });

  it("transfers only the bridge's byte view when it is part of a larger buffer", () => {
    const result = fixture();
    const bridge = bridgeFor(result);
    const source = new Uint8Array(80);
    source.fill(255);
    source.set(new Uint8Array(result.data), 8);
    vi.mocked(bridge.takeData).mockReturnValue(source.subarray(8, 56));
    const reply = callKernel(bridge, "peaks.get", {});
    const received = reply.result as PeaksGetResult;
    expect(received.data.byteLength).toBe(48);
    expect(received.data).not.toBe(source.buffer);
    expect(Array.from(decodePeaks(received).frameCounts)).toEqual([256, 64]);
    expect(reply.transfer).toEqual([received.data]);
  });

  it("rejects mismatched bulk lengths before sending a successful reply", () => {
    const bridge = bridgeFor(fixture());
    vi.mocked(bridge.takeData).mockReturnValue(new Uint8Array(24));
    expect(() => callKernel(bridge, "peaks.get", {})).toThrow(/bulk data length/);
  });

  it("rejects malformed packed bucket metadata", () => {
    const result = fixture();
    result.count = 1;
    expect(() => callKernel(bridgeFor(result), "peaks.get", {})).toThrow(/bucket count/);
  });

  it("leaves ordinary replies intact without taking or transferring bulk data", () => {
    const bridge = bridgeFor(fixture());
    vi.mocked(bridge.call).mockReturnValue(
      JSON.stringify({ ok: true, result: { sampleRate: 48000 } }),
    );
    expect(callKernel(bridge, "hello", undefined)).toEqual({ result: { sampleRate: 48000 } });
    expect(bridge.call).toHaveBeenCalledWith("hello", undefined);
    expect(bridge.takeData).not.toHaveBeenCalled();
  });

  it("propagates kernel errors without taking bulk data", () => {
    const bridge = bridgeFor(fixture());
    vi.mocked(bridge.call).mockReturnValue(
      JSON.stringify({ ok: false, error: "peaks.get: no document" }),
    );
    expect(() => callKernel(bridge, "peaks.get", {})).toThrow("peaks.get: no document");
    expect(bridge.takeData).not.toHaveBeenCalled();
  });
});
