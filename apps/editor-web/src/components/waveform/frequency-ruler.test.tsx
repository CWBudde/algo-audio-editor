import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FrequencyRuler, frequencyTicks } from "./frequency-ruler";

afterEach(cleanup);

describe("linear spectrogram frequency ruler", () => {
  it("retains actual Nyquist and zero endpoints, including uncommon sample rates", () => {
    for (const [sampleRate, label] of [
      [48000, "24"],
      [44100, "22.05"],
      [22050, "11.025"],
      [11025, "5.5125"],
      [44101, "22.0505"],
    ] as const) {
      const ticks = frequencyTicks(sampleRate, 160);
      expect(ticks[0]).toMatchObject({
        hz: sampleRate / 2,
        y: 0,
        labelY: 8,
        value: label,
        unit: "kHz",
      });
      expect(ticks.at(-1)).toEqual({ hz: 0, y: 160, labelY: 152, value: "0", unit: "Hz" });
      for (const tick of ticks) expect(tick.y).toBeCloseTo((1 - tick.hz / (sampleRate / 2)) * 160);
    }
    expect(frequencyTicks(1000, 160)[0]).toMatchObject({ value: "500", unit: "Hz" });
  });

  it("adapts intermediate tick density while preventing overlapping labels in minimum-height lanes", () => {
    for (const sampleRate of [8000, 11025, 44100, 48000, 96000, 192000]) {
      for (const height of [96, 160, 400, 1024]) {
        const ticks = frequencyTicks(sampleRate, height);
        expect(ticks.length).toBeGreaterThan(2);
        expect(ticks.length).toBeLessThanOrEqual(32);
        for (let index = 1; index < ticks.length; index++) {
          expect(ticks[index].hz).toBeLessThan(ticks[index - 1].hz);
          expect(ticks[index].labelY - ticks[index - 1].labelY).toBeGreaterThanOrEqual(24);
        }
      }
    }
    expect(frequencyTicks(48000, 400).length).toBeGreaterThan(frequencyTicks(48000, 96).length);
  });

  it("rejects invalid dimensions/rates and bounds exceptional numeric presentation inputs", () => {
    for (const sampleRate of [0, -48000, NaN, Infinity])
      expect(frequencyTicks(sampleRate, 160)).toEqual([]);
    for (const height of [0, -1, NaN, Infinity]) expect(frequencyTicks(48000, height)).toEqual([]);
    expect(frequencyTicks(Number.MIN_VALUE, 160)).toEqual([]);
    for (const sampleRate of [1e-323, Number.MAX_VALUE]) {
      const ticks = frequencyTicks(sampleRate, 96);
      expect(ticks.length).toBeLessThanOrEqual(32);
      expect(ticks.every((tick) => Number.isFinite(tick.y) && Number.isFinite(tick.hz))).toBe(true);
    }
  });

  it("shows physical channel identity and units without exposing waveform zoom interactions", () => {
    const { getByTestId } = render(<FrequencyRuler sampleRate={44100} height={96} channel={5} />);
    const ruler = getByTestId("spectrogram-frequency-ruler-5");
    expect(ruler.getAttribute("aria-label")).toBe(
      "Channel 6 linear frequency scale, 0 to 22050 Hz",
    );
    expect(ruler.getAttribute("role")).toBe("img");
    expect(ruler.hasAttribute("tabindex")).toBe(false);
    expect(ruler.style.height).toBe("96px");
    expect(ruler.textContent).toContain("22.05 kHz");
    expect(ruler.textContent).toContain("0 Hz");
    expect(
      ruler.querySelector('[data-frequency-hz="22050"]')?.getAttribute("data-frequency-y"),
    ).toBe("0");
  });
});
