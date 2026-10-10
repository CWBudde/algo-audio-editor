import type { ExportDither } from "@aae/protocol";
import type { TimeFormat } from "@/lib/waveform-geometry";

export type ExportFormatPreference = "source" | "wav" | "flac" | "aiff";
/** "auto" dithers with TPDF only when an export reduces resolution to ≤16 bits. */
export type ExportDitherPreference = "auto" | ExportDither;

export interface Preferences {
  exportFormat: ExportFormatPreference;
  exportDither: ExportDitherPreference;
  timeFormat: TimeFormat;
  snap: { zero: boolean; markers: boolean; ticks: boolean };
}

export const DEFAULT_PREFERENCES: Preferences = {
  exportFormat: "source",
  exportDither: "auto",
  timeFormat: "seconds",
  snap: { zero: false, markers: false, ticks: false },
};

/** Bump the suffix when a stored field changes meaning; old values then fall back. */
export const PREFERENCES_KEY = "aae.preferences.v1";

const EXPORT_FORMATS: readonly ExportFormatPreference[] = ["source", "wav", "flac", "aiff"];
const DITHERS: readonly ExportDitherPreference[] = [
  "auto",
  "none",
  "rectangular",
  "triangular",
  "gaussian",
  "fast-gaussian",
];
const TIME_FORMATS: readonly TimeFormat[] = ["samples", "seconds", "hms"];

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Validates each field on its own, so one bad value never discards the rest. */
export function parsePreferences(value: unknown): Preferences {
  if (!value || typeof value !== "object") return DEFAULT_PREFERENCES;
  const stored = value as Partial<Record<keyof Preferences, unknown>>;
  const snap = (stored.snap && typeof stored.snap === "object" ? stored.snap : {}) as Record<
    string,
    unknown
  >;
  return {
    exportFormat: oneOf(stored.exportFormat, EXPORT_FORMATS, DEFAULT_PREFERENCES.exportFormat),
    exportDither: oneOf(stored.exportDither, DITHERS, DEFAULT_PREFERENCES.exportDither),
    timeFormat: oneOf(stored.timeFormat, TIME_FORMATS, DEFAULT_PREFERENCES.timeFormat),
    snap: { zero: snap.zero === true, markers: snap.markers === true, ticks: snap.ticks === true },
  };
}

// Storage can be missing or throw (private windows, blocked site data); the
// editor then keeps preferences for this session only.
function load(): Preferences {
  try {
    const text = localStorage.getItem(PREFERENCES_KEY);
    return text === null ? DEFAULT_PREFERENCES : parsePreferences(JSON.parse(text));
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function store(preferences: Preferences) {
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Session-only; see load().
  }
}

let current: Preferences | undefined;
const listeners = new Set<() => void>();

export function getPreferences(): Preferences {
  current ??= load();
  return current;
}

export function subscribePreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function updatePreferences(change: Partial<Preferences>) {
  const previous = getPreferences();
  const next = parsePreferences({ ...previous, ...change });
  if (JSON.stringify(next) === JSON.stringify(previous)) return;
  current = next;
  store(next);
  for (const listener of listeners) listener();
}

/** Forget the in-memory copy so the next read loads storage again (tests, reloads). */
export function resetPreferences() {
  current = undefined;
}
