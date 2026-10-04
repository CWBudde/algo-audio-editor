import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, type BrowserWindow, dialog, ipcMain } from "electron";
import type { NativeFile } from "../../editor-web/src/platform";
import { trustedWindow } from "./ipc";

// Each capability authorizes one exact user-selected path, for one renderer.
const MAX_BYTES = 1024 * 1024 * 1024;
export const OPEN_EXTENSIONS = new Set([
  "wav",
  "flac",
  "aif",
  "aiff",
  "aifc",
  "mp3",
  "ogg",
  "opus",
  "m4a",
  "aac",
]);
const SAVE_EXTENSIONS = new Set(["wav", "flac", "aiff", "opus", "m4a", "csv", "txt"]);
interface Grant {
  owner: number;
  file: string;
  mode: "read" | "write";
  used: boolean;
}
export function registerFiles(applicationURL: string) {
  const grants = new Map<string, Grant>();
  const pending = new Map<number, NativeFile[]>();
  const grant = (win: BrowserWindow, file: string, mode: Grant["mode"]): NativeFile => {
    if (grants.size >= 256) throw new Error("Too many pending file requests");
    const id = randomUUID();
    grants.set(id, { owner: win.webContents.id, file, mode, used: false });
    return { id, name: path.basename(file) };
  };
  const capability = (owner: number, id: unknown, mode?: Grant["mode"]) => {
    const value = typeof id === "string" ? grants.get(id) : undefined;
    if (!value || value.owner !== owner || (mode && value.mode !== mode))
      throw new Error("File access is not authorized");
    return value;
  };
  ipcMain.handle("files.open", async (event) => {
    const win = trustedWindow(event, applicationURL);
    const result = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      filters: [
        { name: "Audio files", extensions: [...OPEN_EXTENSIONS] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const file = await realpath(result.filePaths[0]);
    return grant(win, file, "read");
  });
  ipcMain.handle("files.save", async (event, name: unknown, extensions: unknown) => {
    const win = trustedWindow(event, applicationURL);
    if (
      typeof name !== "string" ||
      name.length > 255 ||
      path.basename(name) !== name ||
      !Array.isArray(extensions) ||
      !extensions.length ||
      extensions.length > 3 ||
      !extensions.every((e) => typeof e === "string" && SAVE_EXTENSIONS.has(e))
    )
      throw new Error("Invalid save request");
    const result = await dialog.showSaveDialog(win, {
      defaultPath: name,
      filters: [{ name: "Editor export", extensions }],
    });
    if (result.canceled || !result.filePath) return null;
    if (!extensions.includes(path.extname(result.filePath).slice(1).toLowerCase()))
      throw new Error("Unsupported save extension");
    return grant(win, result.filePath, "write");
  });
  ipcMain.handle("files.read", async (event, id: unknown) => {
    const win = trustedWindow(event, applicationURL);
    const value = capability(win.webContents.id, id, "read");
    if (value.used) throw new Error("File has already been read");
    value.used = true;
    const handle = await open(value.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES)
        throw new Error("File exceeds the 1 GiB import limit");
      // Allocate from the checked size; never read an unbounded growing file.
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!result.bytesRead) throw new Error("File changed while reading");
        offset += result.bytesRead;
      }
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    } finally {
      await handle.close();
    }
  });
  ipcMain.handle("files.write", async (event, id: unknown, data: unknown) => {
    const win = trustedWindow(event, applicationURL);
    const value = capability(win.webContents.id, id, "write");
    if (value.used || !(data instanceof ArrayBuffer) || data.byteLength > MAX_BYTES)
      throw new Error("Invalid file output");
    value.used = true;
    const directory = path.dirname(value.file);
    const temporary = path.join(directory, `.${path.basename(value.file)}.${randomUUID()}.tmp`);
    try {
      const existing = await lstat(value.file).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return undefined;
      });
      if (existing && !existing.isFile()) throw new Error("Destination is not a regular file");
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, new Uint8Array(data), {
        flag: "wx",
        mode: existing ? existing.mode & 0o777 : 0o600,
      });
      const handle = await open(temporary, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, value.file);
    } finally {
      grants.delete(id as string);
      await unlink(temporary).catch(() => {});
    }
  });
  ipcMain.handle("files.opened", (event, id: unknown) => {
    const win = trustedWindow(event, applicationURL);
    const value = capability(win.webContents.id, id, "read");
    if (!value.used) throw new Error("File has not been read");
    app.addRecentDocument(value.file);
    grants.delete(id as string);
  });
  ipcMain.handle("files.release", (event, id: unknown) => {
    const win = trustedWindow(event, applicationURL);
    capability(win.webContents.id, id);
    grants.delete(id as string);
  });
  ipcMain.handle("files.take", (event) => {
    const win = trustedWindow(event, applicationURL);
    const files = pending.get(win.webContents.id) ?? [];
    pending.delete(win.webContents.id);
    return files;
  });
  const attach = (win: BrowserWindow) => {
    const owner = win.webContents.id;
    const clear = () => {
      pending.delete(owner);
      for (const [id, value] of grants) if (value.owner === owner) grants.delete(id);
    };
    win.webContents.on("did-start-navigation", (_event, _url, _inPlace, mainFrame) => {
      if (mainFrame) clear();
    });
    win.on("closed", clear);
  };
  const enqueue = async (win: BrowserWindow, input: string) => {
    if (!OPEN_EXTENSIONS.has(path.extname(input).slice(1).toLowerCase()))
      throw new Error("Unsupported audio extension");
    const file = await realpath(input);
    if (!OPEN_EXTENSIONS.has(path.extname(file).slice(1).toLowerCase()))
      throw new Error("Unsupported audio extension");
    if (win.isDestroyed()) return;
    const item = grant(win, file, "read");
    pending.set(win.webContents.id, [...(pending.get(win.webContents.id) ?? []), item]);
    win.webContents.send("files.pending");
  };
  return { attach, enqueue };
}
