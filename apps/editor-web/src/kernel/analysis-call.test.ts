import type { KernelBridge } from "@aae/protocol";
import { expect, it, vi } from "vitest";
import { callKernel } from "./kernel-call";

it("takes a running column snapshot synchronously and transfers owned RGBA bytes", () => {
  const original = new Uint8Array(20);
  original.set([1, 2, 3, 4], 4);
  const bridge: KernelBridge = {
    call: vi.fn(() =>
      JSON.stringify({
        ok: true,
        result: {
          kind: "spectrogram",
          state: "running",
          channels: [0],
          width: 1,
          height: 1,
          dataBytes: 4,
          completedColumns: 1,
        },
      }),
    ),
    takeData: vi.fn(() => original.subarray(4, 8)),
    render: vi.fn(() => 0),
    copyMeters: vi.fn(() => 0),
  };
  const result = callKernel(bridge, "analysis.step", { documentId: "doc", jobId: "job" });
  expect(bridge.takeData).toHaveBeenCalledOnce();
  expect(result.transfer).toHaveLength(1);
  const data = (result.result as { data: ArrayBuffer }).data;
  original.fill(9);
  expect([...new Uint8Array(data)]).toEqual([1, 2, 3, 4]);
  expect(data.byteLength).toBe(4);
});
it("never takes a pending or rejected analysis's prior binary slot", () => {
  const bridge: KernelBridge = {
    call: vi.fn(() => JSON.stringify({ ok: true, result: { state: "running", dataBytes: 0 } })),
    takeData: vi.fn(),
    render: vi.fn(() => 0),
    copyMeters: vi.fn(() => 0),
  };
  callKernel(bridge, "analysis.step", {});
  expect(bridge.takeData).not.toHaveBeenCalled();
  bridge.call = vi.fn(() => JSON.stringify({ ok: false, error: "stale document" }));
  expect(() => callKernel(bridge, "analysis.step", {})).toThrow("stale document");
  expect(bridge.takeData).not.toHaveBeenCalled();
});
it("rejects incorrect RGBA geometry and channel-major spectrum sizes", () => {
  const bridge: KernelBridge = {
    call: vi.fn(() =>
      JSON.stringify({
        ok: true,
        result: { kind: "spectrogram", channels: [0], width: 2, height: 2, dataBytes: 4 },
      }),
    ),
    takeData: vi.fn(() => new Uint8Array(4)),
    render: vi.fn(() => 0),
    copyMeters: vi.fn(() => 0),
  };
  expect(() => callKernel(bridge, "analysis.step", {})).toThrow("invalid analysis data size");
  bridge.call = vi.fn(() =>
    JSON.stringify({ ok: true, result: { channels: 2, bins: 2, dataBytes: 32 } }),
  );
  bridge.takeData = vi.fn(() => new Uint8Array(32));
  expect(() => callKernel(bridge, "analysis.spectrum", {})).toThrow("invalid analysis data size");
});
