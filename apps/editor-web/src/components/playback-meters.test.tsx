import { cleanup, render, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PlaybackMeters } from "./playback-meters";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("labels output units, true peak and provisional LRA without claiming heard audio", () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const ui = render(
    <PlaybackMeters
      snapshot={{
        frames: 48000,
        sampleRate: 48000,
        channels: [
          { channel: 0, peak: 0.5, rms: 0.25, hold: 1, truePeak: 1.1 },
          { channel: 1, peak: 0.25, rms: 0.125, hold: 0.5, truePeak: 0.3 },
        ],
        momentary: -18,
        shortTerm: -19,
        integrated: -20,
        range: 4,
        correlation: -0.75,
        maximumMomentary: -17,
        maximumShortTerm: -18,
        loudnessFrames: 48000,
        rangeStable: false,
        failure: 0,
        availability: 7,
        goniometer: new Float64Array([0.1, 0.2]),
      }}
      onClose={() => {}}
      onReset={() => {}}
    />,
  );
  const firstChannel = within(ui.getByRole("group", { name: "Channel 1 levels" }));
  expect(firstChannel.getByText("True peak")).toBeTruthy();
  expect(firstChannel.getByText("0.8 dBTP")).toBeTruthy();
  expect(firstChannel.getByText("-6.0 dBFS")).toBeTruthy();
  const secondChannel = within(ui.getByRole("group", { name: "Channel 2 levels" }));
  expect(secondChannel.getByText("-10.5 dBTP")).toBeTruthy();
  expect(ui.getByText(/provisional, first 60 s/)).toBeTruthy();
  expect(ui.getByText(/Rendered ahead/)).toBeTruthy();
  expect(ui.getByRole("meter", { name: "Channel 1 peak" }).getAttribute("aria-valuenow")).toBe(
    String(20 * Math.log10(0.5)),
  );
  expect(ui.getByText("-0.750")).toBeTruthy();
});
