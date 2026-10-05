import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadWindowState, persistWindowState } from "./window-state";

const electron = vi.hoisted(() => ({ getPath: vi.fn(), getAllDisplays: vi.fn() }));
vi.mock("electron", () => ({
  app: { getPath: electron.getPath },
  screen: { getAllDisplays: electron.getAllDisplays },
}));

const fallback = { width: 1280, height: 800, maximized: false };
const valid = { x: 40, y: 60, width: 1000, height: 700, maximized: false };
let directory: string;
const store = (state: unknown) =>
  writeFile(path.join(directory, "window-state.json"), JSON.stringify(state));

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "aae-window-unit-"));
  electron.getPath.mockReturnValue(directory);
  electron.getAllDisplays.mockReturnValue([
    { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
  ]);
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

describe("loadWindowState", () => {
  it("uses safe defaults for missing or malformed JSON", async () => {
    expect(await loadWindowState()).toEqual(fallback);
    await writeFile(path.join(directory, "window-state.json"), "{invalid");
    expect(await loadWindowState()).toEqual(fallback);
  });

  it.each([
    null,
    [],
    {},
    { ...valid, x: "40" },
    { ...valid, y: null },
    { ...valid, width: 799 },
    { ...valid, height: 499 },
    { ...valid, width: 16385 },
    { ...valid, height: 16385 },
    { ...valid, x: 1820 },
    { ...valid, x: -900 },
    { ...valid, y: -1 },
    { ...valid, y: 980 },
  ])("rejects invalid dimensions or an unreachable title bar: %j", async (state) => {
    await store(state);
    expect(await loadWindowState()).toEqual(fallback);
  });

  it("keeps bounds on a negative-coordinate secondary display", async () => {
    electron.getAllDisplays.mockReturnValue([
      { workArea: { x: -1920, y: -200, width: 1920, height: 1080 } },
    ]);
    const state = { ...valid, x: -1600, y: -100, maximized: true };
    await store(state);
    expect(await loadWindowState()).toEqual(state);
  });

  it("allows minimum sizes and normalizes maximized to a boolean", async () => {
    await store({ ...valid, width: 800, height: 500, maximized: "true" });
    expect(await loadWindowState()).toEqual({ ...valid, width: 800, height: 500 });
  });

  it("only restores recognized bounds, never arbitrary BrowserWindow options", async () => {
    await store({
      ...valid,
      fullscreen: true,
      alwaysOnTop: true,
      show: false,
      webPreferences: { nodeIntegration: true },
    });
    expect(await loadWindowState()).toEqual(valid);
  });
});

describe("persistWindowState", () => {
  const window = () =>
    Object.assign(new EventEmitter(), {
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => false),
      isMaximized: vi.fn(() => false),
      getNormalBounds: vi.fn(() => ({ x: 80, y: 90, width: 1100, height: 750 })),
    });

  it("coalesces moves and sizes, writes normal bounds, and flushes the final state on close", async () => {
    vi.useFakeTimers();
    const win = window();
    const settled = persistWindowState(win as unknown as BrowserWindow);
    win.emit("move");
    await vi.advanceTimersByTimeAsync(150);
    win.emit("resize");
    await vi.advanceTimersByTimeAsync(199);
    expect(await readdir(directory)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await settled();
    expect(JSON.parse(await readFile(path.join(directory, "window-state.json"), "utf8"))).toEqual({
      x: 80,
      y: 90,
      width: 1100,
      height: 750,
      maximized: false,
    });
    win.getNormalBounds.mockReturnValue({ x: 100, y: 120, width: 1200, height: 800 });
    win.isMaximized.mockReturnValue(true);
    win.emit("move");
    win.emit("close");
    await settled();
    expect(JSON.parse(await readFile(path.join(directory, "window-state.json"), "utf8"))).toEqual({
      x: 100,
      y: 120,
      width: 1200,
      height: 800,
      maximized: true,
    });
    expect(await readdir(directory)).toEqual(["window-state.json"]);
  });

  it.each(["isDestroyed", "isMinimized"] as const)(
    "does not overwrite the last usable state when %s",
    async (method) => {
      await store(valid);
      const win = window();
      win[method].mockReturnValue(true);
      const settled = persistWindowState(win as unknown as BrowserWindow);
      win.emit("close");
      await settled();
      expect(JSON.parse(await readFile(path.join(directory, "window-state.json"), "utf8"))).toEqual(
        valid,
      );
    },
  );
});
