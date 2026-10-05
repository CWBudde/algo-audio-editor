import { describe, expect, it } from "vitest";
import { matchesAccelerator } from "./shortcuts";

const plain = { control: false, meta: false, alt: false, shift: false };

describe("matchesAccelerator", () => {
  it.each([
    ["Command+Shift+Z", { key: "z", ...plain, meta: true, shift: true }],
    ["Control+O", { key: "O", ...plain, control: true }],
    ["Alt+Left", { key: "ArrowLeft", ...plain, alt: true }],
    ["Space", { key: " ", ...plain }],
    ["Home", { key: "Home", ...plain }],
    ["End", { key: "End", ...plain }],
    ["Delete", { key: "Delete", ...plain }],
    [
      "command+ALT+shift+Right",
      { key: "ArrowRight", ...plain, meta: true, alt: true, shift: true },
    ],
  ])("recognizes %s without claiming the renderer command", (accelerator, input) => {
    expect(matchesAccelerator(accelerator, input)).toBe(true);
  });

  it.each([
    ["Command+Z", { key: "z", ...plain, control: true }],
    ["Control+Z", { key: "z", ...plain, meta: true }],
    ["Command+Z", { key: "z", ...plain, meta: true, shift: true }],
    ["Space", { key: " ", ...plain, alt: true }],
    ["Command+Z", { key: "x", ...plain, meta: true }],
    ["Command+Shift+Z", { key: "z", ...plain, meta: true }],
  ])("leaves unmatched modifiers/keys for %s alone", (accelerator, input) => {
    expect(matchesAccelerator(accelerator, input)).toBe(false);
  });
});
