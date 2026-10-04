/**
 * Preload script: the only bridge between the sandboxed renderer and Electron.
 * Everything exposed here is mirrored by DesktopBridge in
 * apps/editor-web/src/platform.ts; keep the two in sync.
 */
import { contextBridge, ipcRenderer } from "electron";

function subscribe<T extends unknown[]>(channel: string, callback: (...args: T) => void) {
  const listener = (_event: unknown, ...args: unknown[]) => callback(...(args as T));
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("aaeDesktop", {
  openFile: () => ipcRenderer.invoke("files.open"),
  saveFile: (name: string, extensions: string[]) =>
    ipcRenderer.invoke("files.save", name, extensions),
  readFile: (id: string) => ipcRenderer.invoke("files.read", id),
  writeFile: (id: string, data: ArrayBuffer) => ipcRenderer.invoke("files.write", id, data),
  didOpenFile: (id: string) => ipcRenderer.invoke("files.opened", id),
  releaseFile: (id: string) => ipcRenderer.invoke("files.release", id),
  pickBatchDirectory: () => ipcRenderer.invoke("files.batch-directory"),
  writeBatchFile: (id: string, name: string, data: ArrayBuffer) =>
    ipcRenderer.invoke("files.batch-write", id, name, data),
  releaseBatchDirectory: (id: string) => ipcRenderer.invoke("files.batch-release", id),
  takeOpenFiles: () => ipcRenderer.invoke("files.take"),
  onOpenFiles: (callback: () => void) => subscribe("files.pending", callback),
  setMenu: (items: unknown) => ipcRenderer.invoke("desktop.menu", items),
  onCommand: (callback: (id: string) => void) => subscribe("desktop.command", callback),
  setDocumentState: (state: unknown) => ipcRenderer.invoke("desktop.state", state),
  onSaveBeforeClose: (callback: (id: string) => void) => subscribe("desktop.save-close", callback),
  completeClose: (request: string, saved: boolean) =>
    ipcRenderer.invoke("desktop.complete-close", request, saved),
  confirmReplace: (name: string) => ipcRenderer.invoke("desktop.confirm-replace", name),
  deleteEffectIR: (id: string): Promise<void> => ipcRenderer.invoke("effects.ir.delete", id),
  loadEffectIR: (id: string): Promise<ArrayBuffer> => ipcRenderer.invoke("effects.ir.load", id),
  saveEffectIR: (id: string, data: ArrayBuffer): Promise<void> =>
    ipcRenderer.invoke("effects.ir.save", id, data),
  loadEffectPresets: (): Promise<string | null> => ipcRenderer.invoke("effects.presets.load"),
  saveEffectPresets: (data: string): Promise<void> =>
    ipcRenderer.invoke("effects.presets.save", data),
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
