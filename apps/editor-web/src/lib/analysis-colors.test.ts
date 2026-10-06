import { expect, it } from "vitest";
import { analysisChannelStyle } from "./analysis-colors";

it("distinguishes eight physical channels by color and dash without selection-dependent renumbering", () => {
  const styles = Array.from({ length: 8 }, (_, channel) => analysisChannelStyle(channel));
  expect(new Set(styles.map(({ color, dash }) => `${color}:${dash ?? "solid"}`)).size).toBe(8);
  expect(styles[0].color).toBe("text-waveform-peak");
  expect(styles.slice(0, 4).every(({ dash }) => dash === undefined)).toBe(true);
  expect(styles.slice(4).every(({ dash }) => dash === "5 3")).toBe(true);
  expect([2, 6].map(analysisChannelStyle)).toEqual([styles[2], styles[6]]);
});
