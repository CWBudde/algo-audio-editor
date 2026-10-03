import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, type IpcMainInvokeEvent, ipcMain } from "electron";

const MAX_PRESET_BYTES = 1024 * 1024;
function trusted(event: IpcMainInvokeEvent, applicationURL: string) {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame || !BrowserWindow.fromWebContents(event.sender))
    throw new Error("Untrusted preset request");
  const source = new URL(frame.url);
  const application = new URL(applicationURL);
  if (source.protocol !== application.protocol || source.host !== application.host)
    throw new Error("Untrusted preset origin");
}
export function registerEffectPresets(applicationURL: string) {
  const resource = (event: IpcMainInvokeEvent, id: unknown) => {
    trusted(event, applicationURL);
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))
      throw new Error("Invalid impulse resource id");
    return path.join(app.getPath("userData"), "effect-impulses", `${id}.wav`);
  };
  ipcMain.handle("effects.ir.delete", async (event, id: unknown) => {
    try {
      await unlink(resource(event, id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  });
  ipcMain.handle("effects.ir.load", async (event, id: unknown) => {
    const file = await readFile(resource(event, id));
    if (file.byteLength > 128 * 1024 * 1024) throw new Error("Impulse file exceeds size limit");
    return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  });
  ipcMain.handle("effects.ir.save", async (event, id: unknown, data: unknown) => {
    const destination = resource(event, id);
    if (!(data instanceof ArrayBuffer) || data.byteLength > 128 * 1024 * 1024)
      throw new Error("Invalid impulse file");
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, new Uint8Array(data), { mode: 0o600, flag: "wx" });
  });
  let pending = Promise.resolve();
  ipcMain.handle("effects.presets.load", async (event) => {
    trusted(event, applicationURL);
    await pending;
    try {
      const data = await readFile(
        path.join(app.getPath("userData"), "effect-presets.json"),
        "utf8",
      );
      if (data.length > MAX_PRESET_BYTES) throw new Error("Preset file exceeds size limit");
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  });
  ipcMain.handle("effects.presets.save", async (event, data: unknown) => {
    trusted(event, applicationURL);
    if (typeof data !== "string" || Buffer.byteLength(data, "utf8") > MAX_PRESET_BYTES)
      throw new Error("Invalid preset data");
    const parsed = JSON.parse(data) as { version?: unknown; presets?: unknown };
    if (parsed?.version !== 1 || !Array.isArray(parsed.presets) || parsed.presets.length > 1000)
      throw new Error("Invalid preset collection");
    const operation = pending.then(async () => {
      const directory = app.getPath("userData");
      await mkdir(directory, { recursive: true });
      const destination = path.join(directory, "effect-presets.json");
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, data, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, destination);
      } finally {
        await unlink(temporary).catch(() => {});
      }
    });
    pending = operation.catch(() => {});
    await operation;
  });
}
