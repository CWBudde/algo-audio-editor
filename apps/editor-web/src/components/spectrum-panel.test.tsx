import type { AnalysisJobResult, DocumentInfoResult } from "@aae/protocol";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { analyse } from "@/kernel/analysis-queue";
import type { KernelClient } from "@/kernel/client";
import { DEFAULT_SPECTRAL_SETTINGS } from "@/lib/analysis-settings";
import { SpectrumPanel } from "./spectrum-panel";

vi.mock("@/kernel/analysis-queue", () => ({ analyse: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

function readySpectrum(sampleRate: number, channels: number[]): AnalysisJobResult {
  const data = new Float64Array(
    channels.flatMap(() => [
      0,
      -120,
      20,
      -120,
      Math.sqrt((20 * sampleRate) / 2),
      -60,
      sampleRate / 2,
      0,
    ]),
  ).buffer;
  return {
    documentId: "doc",
    jobId: "spectrum",
    kind: "spectrum",
    state: "ready",
    start: 0,
    end: 100,
    channelMask: channels.reduce((mask, channel) => mask | (1 << channel), 0),
    processedFrames: 100,
    totalFrames: 100,
    sampleRate,
    channels,
    integratedLUFS: null,
    bins: 4,
    dataBytes: data.byteLength,
    data,
  };
}

async function showSpectrum(result: AnalysisJobResult) {
  vi.mocked(analyse).mockResolvedValue(result);
  const info: DocumentInfoResult = {
    documentId: "doc",
    name: "tone.wav",
    sampleRate: result.sampleRate,
    channels: 8,
    frames: 100,
    bitDepth: 32,
    float: true,
  };
  const ui = render(
    <SpectrumPanel
      client={{} as KernelClient}
      info={info}
      selection={{ start: 0, end: 100, channelMask: result.channelMask }}
      settings={DEFAULT_SPECTRAL_SETTINGS}
      onSettings={vi.fn()}
      playing={false}
      paused={false}
      onClose={vi.fn()}
    />,
  );
  await waitFor(() =>
    expect(ui.getAllByTestId("spectrum-path")).toHaveLength(result.channels.length),
  );
  return ui;
}

it("maps kernel bins to inset logarithmic frequency and dB axes without mutating their data", async () => {
  const result = readySpectrum(8000, [2, 6]);
  const original = new Uint8Array(result.data as ArrayBuffer).slice();
  const ui = await showSpectrum(result);
  for (const path of ui.getAllByTestId("spectrum-path")) {
    expect(path.getAttribute("d")).toBe("M44.00,158.00 L333.00,85.00 L622.00,12.00");
    expect(path.getAttribute("clip-path")).toMatch(/^url\(#.+-plot\)$/);
  }
  const plot = within(ui.getByRole("img", { name: "Frequency spectrum" }));
  expect(plot.getByText("−60")).toBeTruthy();
  expect(plot.getByText("4k")).toBeTruthy();
  expect(plot.queryByText("5k")).toBeNull();
  expect(new Uint8Array(result.data as ArrayBuffer)).toEqual(original);
});

it("keeps selected physical channel labels and matching trace/legend styles distinct", async () => {
  const ui = await showSpectrum(readySpectrum(48000, [2, 6]));
  const legend = within(ui.getByRole("list", { name: "Spectrum channels" }));
  const labels = legend.getAllByRole("listitem");
  expect(labels.map((item) => item.textContent?.trim())).toEqual(["Channel 3", "Channel 7"]);
  const paths = ui.getAllByTestId("spectrum-path");
  for (const [index, label] of labels.entries()) {
    expect(label.querySelector("svg")?.getAttribute("class")).toContain(
      paths[index].getAttribute("class"),
    );
    expect(label.querySelector("line")?.getAttribute("stroke-dasharray")).toBe(
      paths[index].getAttribute("stroke-dasharray"),
    );
  }
  expect(paths[0].getAttribute("stroke-dasharray")).toBeNull();
  expect(paths[1].getAttribute("stroke-dasharray")).toBe("5 3");
});

it("labels a non-round Nyquist frequency exactly and avoids a colliding neighboring tick", async () => {
  const ui = await showSpectrum(readySpectrum(11025, [0]));
  const plot = within(ui.getByRole("img", { name: "Frequency spectrum" }));
  expect(plot.getByText("5.5125k")).toBeTruthy();
  expect(plot.queryByText("5k")).toBeNull();
  expect(ui.getByTestId("spectrum-path").getAttribute("d")).toBe(
    "M44.00,158.00 L333.00,85.00 L622.00,12.00",
  );
});

it("fills the measured plot width and resizes existing results without restarting analysis", async () => {
  let width = 900;
  vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ width }) as DOMRect,
  );
  const ui = await showSpectrum(readySpectrum(8000, [0]));
  const plot = ui.getByRole("img", { name: "Frequency spectrum" });
  expect(plot.getAttribute("viewBox")).toBe("0 0 900 192");
  expect(ui.getByTestId("spectrum-path").getAttribute("d")).toBe(
    "M44.00,158.00 L463.00,85.00 L882.00,12.00",
  );
  width = 520;
  fireEvent(window, new Event("resize"));
  expect(ui.getByRole("img", { name: "Frequency spectrum" })).toBe(plot);
  expect(plot.getAttribute("viewBox")).toBe("0 0 520 192");
  expect(ui.getByTestId("spectrum-path").getAttribute("d")).toBe(
    "M44.00,158.00 L273.00,85.00 L502.00,12.00",
  );
  expect(analyse).toHaveBeenCalledOnce();
});
