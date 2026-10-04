import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, type BrowserWindow, screen } from "electron";

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}
export async function loadWindowState(): Promise<WindowState> {
  const fallback = { width: 1280, height: 800, maximized: false };
  try {
    const state = JSON.parse(
      await readFile(path.join(app.getPath("userData"), "window-state.json"), "utf8"),
    ) as WindowState;
    if (
      ![state.x, state.y, state.width, state.height].every(Number.isFinite) ||
      state.width < 800 ||
      state.height < 500 ||
      state.width > 16384 ||
      state.height > 16384
    )
      return fallback;
    const visible = screen
      .getAllDisplays()
      .some(
        ({ workArea: r }) =>
          (state.x ?? 0) < r.x + r.width - 100 &&
          (state.x ?? 0) + state.width > r.x + 100 &&
          (state.y ?? 0) >= r.y &&
          (state.y ?? 0) < r.y + r.height - 100,
      );
    return visible ? { ...state, maximized: state.maximized === true } : fallback;
  } catch {
    return fallback;
  }
}
export function persistWindowState(win: BrowserWindow) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = Promise.resolve();
  const save = () => {
    if (win.isDestroyed() || win.isMinimized()) return;
    const state = { ...win.getNormalBounds(), maximized: win.isMaximized() };
    pending = pending
      .then(async () => {
        const directory = app.getPath("userData");
        await mkdir(directory, { recursive: true });
        const destination = path.join(directory, "window-state.json");
        const temporary = `${destination}.tmp`;
        await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
        await rename(temporary, destination);
      })
      .catch((error) => console.error("Could not persist window state", error));
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 200);
  };
  win.on("resize", schedule);
  win.on("move", schedule);
  win.on("maximize", schedule);
  win.on("unmaximize", schedule);
  win.on("close", () => {
    clearTimeout(timer);
    save();
  });
  return () => pending;
}
