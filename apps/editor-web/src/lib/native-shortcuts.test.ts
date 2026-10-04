import { expect, it } from "vitest";
import { matchesAccelerator } from "../../../desktop/src/shortcuts";

it("recognizes editor modifiers without intercepting native Quit or text keys", () => {
  const key = { key: "z", meta: true, control: false, alt: false, shift: false };
  expect(matchesAccelerator("Command+Z", key)).toBe(true);
  expect(matchesAccelerator("Command+Shift+Z", key)).toBe(false);
  expect(matchesAccelerator("Command+Shift+Z", { ...key, shift: true })).toBe(true);
  expect(matchesAccelerator("Command+Z", { ...key, key: "q" })).toBe(false);
  expect(matchesAccelerator("Command+Z", { ...key, meta: false })).toBe(false);
  expect(matchesAccelerator("Space", { ...key, meta: false, key: " " })).toBe(true);
  expect(matchesAccelerator("Home", { ...key, meta: false, key: "Home" })).toBe(true);
  expect(matchesAccelerator("Control+Z", { ...key, meta: false, control: true })).toBe(true);
});
