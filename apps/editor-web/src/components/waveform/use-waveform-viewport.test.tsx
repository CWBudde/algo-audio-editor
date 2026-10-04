import type { DocumentInfoResult } from "@aae/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useWaveformViewport } from "./use-waveform-viewport";

const info: DocumentInfoResult = {
  documentId: "doc",
  name: "test",
  frames: 48000,
  sampleRate: 48000,
  channels: 1,
  bitDepth: 32,
  float: true,
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("bounds continuous viewport commits while page mode leaves an in-range viewport alone", () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const renders = vi.fn();
  const lanes = { current: null };
  const hook = renderHook(
    ({ follow }: { follow: "continuous" | "page" }) => {
      renders();
      return useWaveformViewport(info, lanes, true, follow);
    },
    { initialProps: { follow: "continuous" } },
  );
  act(() => hook.result.current.updateViewport(() => ({ start: 0, end: 12000 })));
  act(() => hook.result.current.followPlayback(10000));
  const range = hook.result.current.viewport;
  renders.mockClear();
  for (let tick = 1; tick < 100; tick++) {
    now = tick;
    act(() => hook.result.current.followPlayback(10000 + tick));
  }
  expect(renders).not.toHaveBeenCalled();
  expect(hook.result.current.viewport).toBe(range);
  now = 100;
  act(() => hook.result.current.followPlayback(12000));
  expect(hook.result.current.viewport).toEqual({ start: 6000, end: 18000 });
  hook.rerender({ follow: "page" });
  renders.mockClear();
  for (let frame = 7000; frame < 8000; frame += 100)
    act(() => hook.result.current.followPlayback(frame));
  expect(renders).not.toHaveBeenCalled();
  act(() => hook.result.current.followPlayback(19000));
  expect(hook.result.current.viewport).toEqual({ start: 12000, end: 24000 });
});
