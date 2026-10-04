import type { ExportInfo, KernelBridge } from "@aae/protocol";
import { describe, expect, it, vi } from "vitest";
import { callKernel } from "./kernel-call";

describe("document binary bridge", () => {
  it("passes a WAV view as the third argument and keeps bytes out of JSON", () => {
    const bridge: KernelBridge = {
      call: vi.fn(() => JSON.stringify({ ok: true, result: { name: "test.wav" } })),
      takeData: vi.fn(),
      copyMeters: vi.fn(() => 0),
      render: vi.fn(),
    };
    const bytes = new Uint8Array([82, 73, 70, 70]).buffer;
    callKernel(bridge, "doc.open", { name: "test.wav" }, bytes);
    expect(bridge.call).toHaveBeenCalledWith(
      "doc.open",
      '{"name":"test.wav"}',
      expect.any(Uint8Array),
    );
    const input = vi.mocked(bridge.call).mock.calls[0][2];
    expect(input?.buffer).toBe(bytes);
    expect(bridge.takeData).not.toHaveBeenCalled();
  });

  it("moves exported file bytes without applying peak decoding", () => {
    const info: ExportInfo = { name: "test.wav", mimeType: "audio/wav", dataBytes: 4 };
    const bytes = new Uint8Array([82, 73, 70, 70]);
    const bridge: KernelBridge = {
      call: vi.fn(() => JSON.stringify({ ok: true, result: info })),
      takeData: vi.fn(() => bytes),
      copyMeters: vi.fn(() => 0),
      render: vi.fn(),
    };
    const reply = callKernel(bridge, "doc.export", { format: "wav", bitDepth: 16, float: false });
    expect(reply.result).toEqual({ ...info, data: bytes.buffer });
    expect(reply.transfer).toEqual([bytes.buffer]);
  });

  it("rejects exported file bytes that do not match metadata", () => {
    const bridge: KernelBridge = {
      call: vi.fn(() =>
        JSON.stringify({
          ok: true,
          result: { name: "test.wav", mimeType: "audio/wav", dataBytes: 12 },
        }),
      ),
      takeData: vi.fn(() => new Uint8Array(4)),
      copyMeters: vi.fn(() => 0),
      render: vi.fn(),
    };
    expect(() => callKernel(bridge, "doc.export", {})).toThrow(
      "doc.export: bulk data length does not match metadata",
    );
  });

  it.each(["csv", "labels"] as const)("transfers %s timeline exports as file bytes", (format) => {
    const bytes = new Uint8Array(new TextEncoder().encode("0.000000000\t0.000000000\tCue\n"));
    const info: ExportInfo = {
      name: "test.labels.txt",
      mimeType: "text/plain;charset=utf-8",
      dataBytes: bytes.byteLength,
    };
    const bridge: KernelBridge = {
      call: vi.fn(() => JSON.stringify({ ok: true, result: info })),
      takeData: vi.fn(() => bytes),
      copyMeters: vi.fn(() => 0),
      render: vi.fn(),
    };
    const reply = callKernel(bridge, "timeline.export", { documentId: "doc-1", format });
    expect(reply.result).toEqual({ ...info, data: bytes.buffer });
    expect(reply.transfer).toEqual([bytes.buffer]);
    const received = structuredClone(reply.result as ExportInfo & { data: ArrayBuffer }, {
      transfer: reply.transfer,
    });
    expect(bytes.byteLength).toBe(0);
    expect(new TextDecoder().decode(received.data)).toContain("Cue");
  });

  it("rejects mismatched timeline bulk lengths", () => {
    const bridge: KernelBridge = {
      call: vi.fn(() => JSON.stringify({ ok: true, result: { dataBytes: 100 } })),
      takeData: vi.fn(() => new Uint8Array(4)),
      copyMeters: vi.fn(() => 0),
      render: vi.fn(),
    };
    expect(() => callKernel(bridge, "timeline.export", {})).toThrow(
      "timeline.export: bulk data length does not match metadata",
    );
  });
});

it("takes the effect curve's binary slot before another RPC can overwrite it and transfers only the owned view", () => {
  const allocation = new Uint8Array(48);
  const view = allocation.subarray(8, 40);
  new DataView(allocation.buffer).setFloat64(8, 1000, true);
  let slot = view;
  const bridge: KernelBridge = {
    call: vi.fn((method) => {
      if (method === "effects.response")
        return JSON.stringify({ ok: true, result: { axis: "frequency", count: 2, dataBytes: 32 } });
      slot = new Uint8Array(0);
      return JSON.stringify({ ok: true, result: {} });
    }),
    takeData: vi.fn(() => slot),
    copyMeters: vi.fn(() => 0),
    render: vi.fn(),
  };
  const response = callKernel(bridge, "effects.response", { effectId: "eq-parametric" });
  callKernel(bridge, "hello", undefined);
  const result = response.result as { data: ArrayBuffer };
  expect(result.data.byteLength).toBe(32);
  expect(new DataView(result.data).getFloat64(0, true)).toBe(1000);
  expect(response.transfer).toEqual([result.data]);
  expect(allocation.byteLength).toBe(48);
});
it("rejects bad effect bulk lengths and never takes stale data from a rejected response", () => {
  const takeData = vi.fn(() => new Uint8Array(16));
  const call = vi.fn(() => JSON.stringify({ ok: true, result: { count: 2, dataBytes: 32 } }));
  const bridge = { call, takeData, copyMeters: vi.fn(() => 0), render: vi.fn() };
  expect(() => callKernel(bridge, "effects.response", {})).toThrow("bulk data length");
  takeData.mockClear();
  call.mockReturnValue(JSON.stringify({ ok: false, error: "invalid effect" }));
  expect(() => callKernel(bridge, "effects.response", {})).toThrow("invalid effect");
  expect(takeData).not.toHaveBeenCalled();
});
