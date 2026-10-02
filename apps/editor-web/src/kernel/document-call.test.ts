import type { ExportInfo, KernelBridge } from "@aae/protocol";
import { describe, expect, it, vi } from "vitest";
import { callKernel } from "./kernel-call";

describe("document binary bridge", () => {
  it("passes a WAV view as the third argument and keeps bytes out of JSON", () => {
    const bridge: KernelBridge = {
      call: vi.fn(() => JSON.stringify({ ok: true, result: { name: "test.wav" } })),
      takeData: vi.fn(),
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
      render: vi.fn(),
    };
    expect(() => callKernel(bridge, "doc.export", {})).toThrow(
      "doc.export: bulk data length does not match metadata",
    );
  });
});
