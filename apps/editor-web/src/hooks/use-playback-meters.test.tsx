import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { METERS_DATA_BYTES, METERS_HEADER_BYTES, MeterPublisher } from "@/audio/meter-data";
import type { KernelClient } from "@/kernel/client";
import { usePlaybackMeters } from "./use-playback-meters";

const info = {
  documentId: "doc",
  name: "audio",
  sampleRate: 48000,
  channels: 2,
  frames: 100,
  bitDepth: 32,
  float: true,
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("does not attach or enable meters while their panel is hidden, and detaches its captured client", async () => {
  const old = {
      call: vi.fn().mockResolvedValue({}),
      attachMeters: vi.fn().mockResolvedValue(undefined),
    },
    next = {
      call: vi.fn().mockResolvedValue({}),
      attachMeters: vi.fn().mockResolvedValue(undefined),
    };
  const ui = renderHook(({ client, enabled }) => usePlaybackMeters(client, info, enabled), {
    initialProps: { client: old as unknown as KernelClient, enabled: false },
  });
  expect(old.call).not.toHaveBeenCalled();
  expect(old.attachMeters).not.toHaveBeenCalled();
  await act(async () => ui.rerender({ client: old as unknown as KernelClient, enabled: true }));
  expect(old.call).toHaveBeenCalledWith("meters.configure", { enabled: true, reset: true });
  await act(async () => ui.rerender({ client: next as unknown as KernelClient, enabled: true }));
  expect(old.call).toHaveBeenLastCalledWith("meters.configure", { enabled: false });
  expect(old.attachMeters).toHaveBeenLastCalledWith();
  expect(next.call).toHaveBeenCalledWith("meters.configure", { enabled: true, reset: true });
  ui.unmount();
  expect(next.call).toHaveBeenLastCalledWith("meters.configure", { enabled: false });
});

it("retains the last coherent snapshot when a read overlaps publication and clears it on disable", async () => {
  vi.useFakeTimers();
  let buffer: SharedArrayBuffer | undefined;
  const client = {
    call: vi.fn().mockResolvedValue({}),
    attachMeters: vi.fn(async (next?: SharedArrayBuffer) => {
      buffer = next;
      if (next)
        new MeterPublisher(next).publish((bytes) => {
          const data = new Float64Array(bytes.buffer, bytes.byteOffset);
          data.set([1, 2, 128, 48000, -18, -19, -20, 0, 1, 0]);
          data[16] = 0.5;
          return METERS_DATA_BYTES;
        });
    }),
  } as unknown as KernelClient;
  const ui = renderHook(({ enabled }) => usePlaybackMeters(client, info, enabled), {
    initialProps: { enabled: true },
  });
  await act(async () => Promise.resolve());
  expect(ui.result.current.snapshot?.channels[0].peak).toBe(0.5);
  if (!buffer) throw new Error("meter buffer missing");
  const header = new Int32Array(buffer, 0, 2);
  Atomics.add(header, 0, 1);
  await act(async () => vi.advanceTimersByTime(100));
  expect(ui.result.current.snapshot?.channels[0].peak).toBe(0.5);
  new Float64Array(buffer, METERS_HEADER_BYTES)[16] = 0.25;
  Atomics.add(header, 0, 1);
  await act(async () => vi.advanceTimersByTime(50));
  expect(ui.result.current.snapshot?.channels[0].peak).toBe(0.25);
  ui.rerender({ enabled: false });
  expect(ui.result.current.snapshot).toBeUndefined();
});
