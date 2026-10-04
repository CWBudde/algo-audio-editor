import type { DocumentInfoResult } from "@aae/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { KernelClient } from "@/kernel/client";
import { useAutomation } from "./use-automation";

const info: DocumentInfoResult = {
  documentId: "doc-1",
  name: "test.wav",
  frames: 100,
  channels: 2,
  sampleRate: 48000,
  bitDepth: 16,
  float: false,
};
const request = {
  method: "process.start" as const,
  params: {
    documentId: info.documentId,
    start: 0,
    end: 100,
    channelMask: 3,
    operation: "reverse" as const,
  },
};
function setup() {
  return renderHook(() =>
    useAutomation({
      client: {} as KernelClient,
      info,
      busy: false,
      withOperation: async (work) => work(),
      beforeEdit: vi.fn(),
      onEdited: vi.fn(),
    }),
  );
}
afterEach(cleanup);
it("records only while enabled, preserves the chain on stop and resets it for a new recording", () => {
  const { result } = setup();
  act(() => result.current.record(request, info));
  expect(result.current.chain.operations).toHaveLength(0);
  act(() => result.current.startRecording());
  act(() => result.current.record(request, info));
  act(() => result.current.stopRecording());
  act(() => result.current.record(request, info));
  expect(result.current.chain.operations).toHaveLength(1);
  expect(result.current.recording).toBe(false);
  act(() => result.current.startRecording());
  expect(result.current.chain.operations).toHaveLength(0);
});
it("stops at the cap or an unsupported session asset and retains the preceding steps", () => {
  const { result } = setup();
  act(() => result.current.startRecording());
  act(() => {
    for (let i = 0; i < 65; i++) result.current.record(request, info);
  });
  expect(result.current.chain.operations).toHaveLength(64);
  expect(result.current.recording).toBe(false);
  expect(result.current.error).toContain("64");
  expect(result.current.open).toBe(true);
  act(() => result.current.startRecording());
  act(() => result.current.record(request, info));
  act(() =>
    result.current.record(
      { ...request, params: { ...request.params, operation: "extract-channel", channel: 0 } },
      info,
    ),
  );
  expect(result.current.chain.operations).toHaveLength(1);
  expect(result.current.error).toContain("extraction");
  expect(result.current.recording).toBe(false);
});
it("loads valid chains and preserves the previous chain after invalid or oversized imports", async () => {
  const { result } = setup();
  const file = (text: string) => ({ size: text.length, text: async () => text }) as File;
  await act(async () =>
    result.current.load(
      file(
        '{"version":1,"operations":[{"method":"process.start","range":"document","params":{"operation":"reverse"}}]}',
      ),
    ),
  );
  const original = result.current.chain;
  await act(async () => result.current.load(file('{"version":99,"operations":[]}')));
  expect(result.current.chain).toBe(original);
  expect(result.current.error).toContain("version 1");
  await act(async () => result.current.load({ size: 1024 * 1024 + 1 } as File));
  expect(result.current.chain).toBe(original);
  expect(result.current.error).toContain("1 MiB");
});
