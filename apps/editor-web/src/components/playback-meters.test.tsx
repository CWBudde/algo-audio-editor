import { cleanup, render } from "@testing-library/react";
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
  expect(ui.getByText(/True peak 0.8 dBTP/)).toBeTruthy();
  expect(ui.getByText(/provisional, first 60 s/)).toBeTruthy();
  expect(ui.getByText(/Rendered ahead/)).toBeTruthy();
  expect(ui.getByRole("meter", { name: "Channel 1 peak" }).getAttribute("aria-valuenow")).toBe(
    String(20 * Math.log10(0.5)),
  );
  expect(ui.getByText("-0.750")).toBeTruthy();
});
