/// <reference types="node" />

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EDITOR_THEME_PROPERTIES, resolveEditorPalette } from "./editor-theme";
import { drawSampleWaveform, drawWaveform } from "./waveform-drawing";

// Read the production defaults, rather than maintaining a second test palette.
const stylesheet = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../index.css"),
  "utf8",
);
const rootBlock = stylesheet.match(/:root\s*\{([^}]+)\}/)?.[1] ?? "";
const defaults = new Map(
  [...rootBlock.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((entry) => [entry[1], entry[2].trim()]),
);

function defaultValue(property: string): string {
  const value = defaults.get(property);
  if (!value) throw new Error(`Missing CSS default ${property}`);
  return value.replace(/var\((--[\w-]+)\)/g, (_, alias: string) => defaultValue(alias));
}

function computed(values: Partial<Record<string, string>> = {}): CSSStyleDeclaration {
  return {
    getPropertyValue: (property: string) => values[property] ?? defaultValue(property),
  } as CSSStyleDeclaration;
}

function rgb(hex: string): number[] {
  return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
}

function luminance(hex: string): number {
  const channels = rgb(hex).map((byte) => {
    const normalized = byte / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(first: string, second: string): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("editor theme", () => {
  it("defines every canvas role in CSS and resolves a frozen, concrete palette", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue(computed());
    const palette = resolveEditorPalette();
    expect(Object.isFrozen(palette)).toBe(true);
    for (const key of Object.keys(EDITOR_THEME_PROPERTIES) as (keyof typeof palette)[]) {
      expect(palette[key]).toBe(defaultValue(EDITOR_THEME_PROPERTIES[key]));
      expect(palette[key]).toMatch(/^#[\da-f]{6}(?:[\da-f]{2})?$/i);
    }
  });

  it("shares orchid selection/focus, bright tonal gold signals, and a warm pale playhead", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue(computed());
    const palette = resolveEditorPalette();
    expect(palette.focus).toBe(palette.primary);
    expect(palette.selection).toBe(palette.primary);
    expect(palette.waveformSample).toBe(palette.waveformPeak);
    expect(palette.warning).toBe(palette.playhead);
    expect(palette.error).toBe(palette.destructive);
    const [purpleR, purpleG, purpleB] = rgb(palette.primary);
    expect(purpleB).toBeGreaterThan(purpleR);
    expect(purpleR).toBeGreaterThan(purpleG);
    expect(purpleR - purpleG).toBeGreaterThan(40);
    expect(purpleB - purpleG).toBeGreaterThan(60);
    const [amberR, amberG, amberB] = rgb(palette.waveformPeak);
    expect(amberR).toBeGreaterThan(amberG);
    expect(amberG).toBeGreaterThan(amberB);
    expect(amberG / amberR).toBeGreaterThan(0.8);
    const [rmsR, rmsG, rmsB] = rgb(palette.waveformRms);
    expect(rmsR).toBeGreaterThan(rmsG);
    expect(rmsG).toBeGreaterThan(rmsB);
    expect(Math.abs(amberG / amberR - rmsG / rmsR)).toBeLessThan(0.05);
    expect(Math.abs(amberB / amberR - rmsB / rmsR)).toBeLessThan(0.05);
    const [yellowR, yellowG, yellowB] = rgb(palette.playhead);
    expect(Math.min(yellowR, yellowG)).toBeGreaterThan(yellowB * 1.3);
    expect(luminance(palette.playhead)).toBeGreaterThan(luminance(palette.waveformPeak));
    const [redR, redG, redB] = rgb(palette.error);
    expect(redR).toBeGreaterThan(Math.max(redG, redB) * 1.5);
    expect(luminance(palette.waveformRms)).toBeLessThan(luminance(palette.waveformPeak));
    expect(luminance(palette.waveformGrid)).toBeLessThan(luminance(palette.waveformCenter));
    expect(luminance(palette.waveformCenter)).toBeLessThan(luminance(palette.waveformRms));
    expect(contrast(palette.waveformPeak, palette.waveformBackground)).toBeGreaterThan(4.5);
  });

  it("keeps ink-blue surfaces quiet and progressively raises interactive surfaces", () => {
    const surfaces = [
      "--editor-background",
      "--editor-surface",
      "--editor-surface-raised",
      "--editor-surface-hover",
    ].map(defaultValue);
    for (const surface of surfaces) {
      const [red, green, blue] = rgb(surface);
      expect(blue).toBeGreaterThan(Math.max(red, green));
      expect(luminance(surface)).toBeLessThan(0.05);
    }
    for (let index = 1; index < surfaces.length; index++)
      expect(luminance(surfaces[index])).toBeGreaterThan(luminance(surfaces[index - 1]));
  });

  it("keeps normal/muted text and primary control labels readable on dark surfaces", () => {
    expect(contrast(defaultValue("--foreground"), defaultValue("--background"))).toBeGreaterThan(
      4.5,
    );
    expect(contrast(defaultValue("--muted-foreground"), defaultValue("--muted"))).toBeGreaterThan(
      4.5,
    );
    expect(
      contrast(defaultValue("--primary-foreground"), defaultValue("--primary")),
    ).toBeGreaterThan(4.5);
    expect(
      contrast(defaultValue("--editor-focus"), defaultValue("--editor-surface")),
    ).toBeGreaterThan(3);
    expect(
      contrast(defaultValue("--primary-foreground"), defaultValue("--editor-primary-hover")),
    ).toBeGreaterThan(4.5);
    expect(
      contrast(defaultValue("--muted-foreground"), defaultValue("--editor-surface-hover")),
    ).toBeGreaterThan(4.5);
    for (const role of ["--editor-control-border", "--editor-control-track"])
      expect(
        contrast(defaultValue(role), defaultValue("--editor-waveform-background")),
      ).toBeGreaterThan(3);
  });

  it("keeps every chart and band identity visible on the signal surface", () => {
    const surface = defaultValue("--editor-waveform-background");
    for (let index = 1; index <= 8; index++)
      expect(contrast(defaultValue(`--editor-band-${index}`), surface)).toBeGreaterThan(3);
    for (let index = 1; index <= 4; index++)
      expect(contrast(defaultValue(`--chart-${index}`), surface)).toBeGreaterThan(3);
  });

  it("keeps standalone waveform painter defaults synchronized with CSS signal roles", () => {
    const fills: string[] = [];
    const strokes: string[] = [];
    const ctx = {
      clearRect() {},
      save() {},
      restore() {},
      beginPath() {},
      rect() {},
      clip() {},
      moveTo() {},
      lineTo() {},
      arc() {},
      fill() {},
      fillRect() {
        fills.push(this.fillStyle);
      },
      stroke() {
        strokes.push(this.strokeStyle);
      },
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 0,
    };
    const peaks = {
      startFrames: new Float64Array([0]),
      frameCounts: new Uint32Array([1]),
      peaks: new Float32Array([-0.5, -0.5, 0.5]),
    };
    drawWaveform(ctx as unknown as CanvasRenderingContext2D, peaks, { start: 0, end: 1 }, 100, 50);
    expect(fills).toEqual([
      defaultValue("--editor-waveform-peak"),
      defaultValue("--editor-waveform-rms"),
    ]);
    drawSampleWaveform(
      ctx as unknown as CanvasRenderingContext2D,
      [peaks],
      { start: 0, end: 1 },
      100,
      50,
    );
    expect(strokes).toEqual([defaultValue("--editor-waveform-peak")]);
  });

  it("maps DOM controls to the same semantic roles without defining marker colors", () => {
    for (const [dom, role] of [
      ["--primary", "--editor-primary"],
      ["--ring", "--editor-focus"],
      ["--destructive", "--editor-destructive"],
      ["--background", "--editor-background"],
      ["--input", "--editor-control-border"],
      ["--accent", "--editor-surface-hover"],
    ]) {
      expect(defaults.get(dom)).toBe(`var(${role})`);
    }
    expect(stylesheet).not.toMatch(/--editor-(?:marker|region)/);
    for (const token of [
      "warning",
      "playhead",
      "selection",
      "waveform-peak",
      "waveform-sample",
      "waveform-rms",
      "waveform-grid",
      "waveform-center",
      "trace-secondary",
      "trace-tertiary",
      "trace-quaternary",
      "control-track",
    ]) {
      expect(stylesheet).toContain(`--color-${token}: var(--editor-${token});`);
    }
  });

  it("respects scoped overrides, trims values, and falls back to the owner document root", () => {
    const canvas = document.createElement("canvas");
    const rootStyles = computed();
    const localStyles = {
      getPropertyValue: (property: string) =>
        property === "--editor-waveform-peak" ? "  rgb(1 2 3)  " : "",
    } as CSSStyleDeclaration;
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
      element === canvas ? localStyles : rootStyles,
    );
    const palette = resolveEditorPalette(canvas);
    expect(palette.waveformPeak).toBe("rgb(1 2 3)");
    expect(palette.waveformRms).toBe(defaultValue("--editor-waveform-rms"));
  });

  it("does not retain stale snapshots when the theme changes", () => {
    const values: Record<string, string> = {};
    vi.spyOn(window, "getComputedStyle").mockReturnValue(computed(values));
    const before = resolveEditorPalette();
    values[EDITOR_THEME_PROPERTIES.waveformPeak] = "#123456";
    expect(resolveEditorPalette().waveformPeak).toBe("#123456");
    expect(before.waveformPeak).toBe(defaultValue("--editor-waveform-peak"));
  });

  it.each(["", "var(--missing)", "VAR (--missing)"])(
    "rejects missing or unresolved styles (%s)",
    (value) => {
      vi.spyOn(window, "getComputedStyle").mockReturnValue(computed({ "--editor-primary": value }));
      expect(() => resolveEditorPalette()).toThrow(
        "Editor theme property --editor-primary is missing or unresolved",
      );
    },
  );

  it("rejects documents without a computed-style view", () => {
    const detached = document.implementation.createHTMLDocument();
    expect(() => resolveEditorPalette(detached.documentElement)).toThrow(
      "Editor theme needs a document with computed styles",
    );
  });
});
