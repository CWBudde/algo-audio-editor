import { expect, it } from "vitest";
import {
  DEFAULT_PREFERENCES,
  getPreferences,
  PREFERENCES_KEY,
  parsePreferences,
  resetPreferences,
  subscribePreferences,
  updatePreferences,
} from "./preferences";

it("starts from defaults when nothing is stored", () => {
  expect(getPreferences()).toEqual(DEFAULT_PREFERENCES);
  expect(DEFAULT_PREFERENCES).toEqual({
    exportFormat: "source",
    exportDither: "auto",
    timeFormat: "seconds",
    snap: { zero: false, markers: false, ticks: false },
  });
});

it("persists every change as versioned JSON and notifies subscribers", () => {
  const seen: unknown[] = [];
  const unsubscribe = subscribePreferences(() => seen.push(getPreferences()));
  updatePreferences({ timeFormat: "hms" });
  updatePreferences({ snap: { zero: true, markers: false, ticks: true } });
  unsubscribe();
  updatePreferences({ exportFormat: "flac" });
  expect(seen).toHaveLength(2);
  expect(JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? "null")).toEqual({
    ...DEFAULT_PREFERENCES,
    exportFormat: "flac",
    timeFormat: "hms",
    snap: { zero: true, markers: false, ticks: true },
  });
  // A new session reads what the last one stored.
  resetPreferences();
  expect(getPreferences().exportFormat).toBe("flac");
});

it("keeps the same snapshot object until something changes", () => {
  const first = getPreferences();
  expect(getPreferences()).toBe(first);
  updatePreferences({ timeFormat: "seconds" });
  expect(getPreferences()).toBe(first);
  updatePreferences({ timeFormat: "samples" });
  expect(getPreferences()).not.toBe(first);
});

it("falls back field by field on malformed or foreign stored values", () => {
  expect(parsePreferences(null)).toEqual(DEFAULT_PREFERENCES);
  expect(parsePreferences("text")).toEqual(DEFAULT_PREFERENCES);
  expect(
    parsePreferences({
      exportFormat: "mp3",
      exportDither: "gaussian",
      timeFormat: 3,
      snap: { zero: true, markers: "yes" },
    }),
  ).toEqual({
    ...DEFAULT_PREFERENCES,
    exportDither: "gaussian",
    snap: { zero: true, markers: false, ticks: false },
  });
  localStorage.setItem(PREFERENCES_KEY, "{not json");
  resetPreferences();
  expect(getPreferences()).toEqual(DEFAULT_PREFERENCES);
});

it("keeps working in memory when storage is unavailable", () => {
  const { getItem, setItem } = Storage.prototype;
  Storage.prototype.getItem = () => {
    throw new Error("blocked");
  };
  Storage.prototype.setItem = () => {
    throw new Error("blocked");
  };
  try {
    resetPreferences();
    expect(getPreferences()).toEqual(DEFAULT_PREFERENCES);
    updatePreferences({ timeFormat: "samples" });
    expect(getPreferences().timeFormat).toBe("samples");
  } finally {
    Storage.prototype.getItem = getItem;
    Storage.prototype.setItem = setItem;
  }
});
