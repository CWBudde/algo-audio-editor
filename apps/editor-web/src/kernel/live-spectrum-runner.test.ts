import { expect, it, vi } from "vitest";
import { runLiveSpectrum, validLiveSpectrum } from "./live-spectrum-runner";

const metadata = {
  documentId: "doc",
  jobId: "live",
  source: "playback",
  sampleRate: 48000,
  channels: 1,
  fftSize: 256,
  bins: 129,
  dataBytes: 0,
};
it("keeps one live identity through bounded yields and releases its ready snapshot", async () => {
  const step = vi
      .fn()
      .mockReturnValueOnce({ result: { ...metadata, state: "running" } })
      .mockReturnValueOnce({
        result: { ...metadata, state: "ready", dataBytes: 2064, data: new ArrayBuffer(2064) },
      }),
    cancel = vi.fn(),
    yieldTask = vi.fn().mockResolvedValue(undefined);
  await runLiveSpectrum(
    { source: "playback" },
    { step, cancel, yieldTask, cancelled: () => false },
  );
  expect(step.mock.calls[1][0]).toEqual({ source: "playback", jobId: "live" });
  expect(yieldTask).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledWith({ documentId: "doc", jobId: "live" });
});
it("cancels its captured job when the panel closes between steps", async () => {
  let cancelled = false;
  const step = vi.fn().mockReturnValue({ result: { ...metadata, state: "running" } }),
    cancel = vi.fn();
  await expect(
    runLiveSpectrum(
      { source: "playback" },
      {
        step,
        cancel,
        yieldTask: async () => {
          cancelled = true;
        },
        cancelled: () => cancelled,
      },
    ),
  ).rejects.toThrow("Spectrum cancelled");
  expect(step).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledWith({ documentId: "doc", jobId: "live" });
});
it("rejects document or job replacement rather than silently displaying a different snapshot", async () => {
  const step = vi
      .fn()
      .mockReturnValueOnce({ result: { ...metadata, state: "running" } })
      .mockReturnValueOnce({
        result: { ...metadata, documentId: "replacement", jobId: "new", state: "ready" },
      }),
    cancel = vi.fn();
  await expect(
    runLiveSpectrum(
      { source: "playback" },
      { step, cancel, yieldTask: async () => {}, cancelled: () => false },
    ),
  ).rejects.toThrow("Invalid live spectrum identity");
  expect(cancel).toHaveBeenCalledWith({ documentId: "doc", jobId: "live" });
});

it.each([
  { sampleRate: NaN },
  { channels: 9 },
  { fftSize: 512 },
  { dataBytes: 0 },
  { data: new ArrayBuffer(8) },
])("rejects malformed terminal spectrum geometry %j", (change) => {
  expect(
    validLiveSpectrum({
      ...metadata,
      state: "ready",
      dataBytes: 2064,
      data: new ArrayBuffer(2064),
      ...change,
    }),
  ).toBe(false);
});
