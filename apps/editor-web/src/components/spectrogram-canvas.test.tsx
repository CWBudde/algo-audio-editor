import type { AnalysisJobResult } from "@aae/protocol";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { analyse } from "@/kernel/analysis-queue";
import type { KernelClient } from "@/kernel/client";
import { DEFAULT_SPECTRAL_SETTINGS } from "@/lib/analysis-settings";
import { SpectrogramCanvas } from "./spectrogram-canvas";

vi.mock("@/kernel/analysis-queue", () => ({ analyse: vi.fn() }));
const info = {
  documentId: "doc",
  name: "tone.wav",
  frames: 48000,
  sampleRate: 48000,
  channels: 1,
  bitDepth: 32,
  float: true,
};
const context = { clearRect: vi.fn(), putImageData: vi.fn() };
function tile(value: number): AnalysisJobResult {
  return {
    documentId: "doc",
    jobId: "tile",
    start: 0,
    end: 48000,
    channelMask: 1,
    kind: "spectrogram",
    state: "ready",
    sampleRate: 48000,
    channels: [0],
    processedFrames: 48000,
    totalFrames: 48000,
    integratedLUFS: null,
    width: 128,
    height: 8,
    dataBytes: 4096,
    completedColumns: 128,
    data: new Uint8Array(4096).fill(value).buffer,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  vi.stubGlobal(
    "ImageData",
    class {
      data: Uint8ClampedArray;
      width: number;
      height: number;
      constructor(data: Uint8ClampedArray, width: number, height: number) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function props() {
  return {
    client: {} as KernelClient,
    info,
    channel: 0,
    viewport: { start: 0, end: 48000 },
    width: 128,
    height: 8,
    settings: DEFAULT_SPECTRAL_SETTINGS,
    paused: false,
  };
}
it("invalidates same-length edits by history state and reuses the correct undo tile", async () => {
  vi.mocked(analyse).mockResolvedValueOnce(tile(10)).mockResolvedValueOnce(tile(200));
  const p = props(),
    ui = render(<SpectrogramCanvas {...p} stateId="original" />);
  await waitFor(() => expect(context.putImageData).toHaveBeenCalledTimes(1));
  ui.rerender(<SpectrogramCanvas {...p} stateId="gain" />);
  await waitFor(() => expect(context.putImageData).toHaveBeenCalledTimes(2));
  expect(context.putImageData.mock.calls[1][0].data[0]).toBe(200);
  ui.rerender(<SpectrogramCanvas {...p} stateId="original" />);
  await waitFor(() => expect(context.putImageData).toHaveBeenCalledTimes(3));
  expect(context.putImageData.mock.calls[2][0].data[0]).toBe(10);
  expect(analyse).toHaveBeenCalledTimes(2);
});
it("paints progressive columns before completion and fences stale in-flight tiles", async () => {
  let resolve!: (job: AnalysisJobResult) => void;
  vi.mocked(analyse)
    .mockImplementationOnce(async (_client, _params, _signal, progress) => {
      progress?.({ ...tile(10), state: "running", completedColumns: 4 });
      return new Promise((done) => {
        resolve = done;
      });
    })
    .mockResolvedValueOnce(tile(200));
  const p = props(),
    ui = render(<SpectrogramCanvas {...p} stateId="original" />);
  await waitFor(() => expect(ui.getByRole("img").getAttribute("data-painted-columns")).toBe("4"));
  ui.rerender(<SpectrogramCanvas {...p} stateId="edited" />);
  await waitFor(() => expect(ui.getByRole("img").getAttribute("data-painted-columns")).toBe("128"));
  resolve(tile(10));
  await Promise.resolve();
  expect(context.putImageData.mock.calls.at(-1)?.[0].data[0]).toBe(200);
  expect(vi.mocked(analyse).mock.calls[0][2].aborted).toBe(true);
});

it.each([
  { start: 48000, end: 49000 },
  { start: 50000, end: 52000 },
  { start: 10, end: 10 },
  { start: -200, end: 0 },
])("does not turn a blank viewport %j into whole-document analysis", async (viewport) => {
  render(<SpectrogramCanvas {...props()} viewport={viewport} />);
  await Promise.resolve();
  expect(analyse).not.toHaveBeenCalled();
  expect(context.clearRect).toHaveBeenCalled();
});
it("leaves the EOF tail transparent while preserving its viewport columns", async () => {
  vi.mocked(analyse).mockImplementation(async (_client, params) => ({
    ...tile(10),
    width: params.width,
    dataBytes: (params.width ?? 0) * 8 * 4,
    data: new Uint8Array((params.width ?? 0) * 8 * 4).buffer,
  }));
  render(<SpectrogramCanvas {...props()} viewport={{ start: 47900, end: 48100 }} />);
  await waitFor(() => expect(context.putImageData).toHaveBeenCalledTimes(1));
  expect(vi.mocked(analyse).mock.calls[0][1]).toMatchObject({
    start: 47900,
    end: 48000,
    width: 64,
  });
  expect(context.putImageData.mock.calls[0][0].width).toBe(64);
});
it("requests nonempty ranges when zoomed to more than one pixel per sample", async () => {
  vi.mocked(analyse).mockImplementation(async (_client, params) => ({
    ...tile(10),
    width: params.width,
    dataBytes: (params.width ?? 0) * 8 * 4,
    data: new Uint8Array((params.width ?? 0) * 8 * 4).buffer,
  }));
  render(
    <SpectrogramCanvas
      {...props()}
      info={{ ...info, frames: 5 }}
      width={256}
      viewport={{ start: 0, end: 5 }}
    />,
  );
  await waitFor(() => expect(context.putImageData).toHaveBeenCalledTimes(2));
  expect(vi.mocked(analyse).mock.calls.map((call) => [call[1].start, call[1].end])).toEqual([
    [0, 3],
    [2, 5],
  ]);
});
