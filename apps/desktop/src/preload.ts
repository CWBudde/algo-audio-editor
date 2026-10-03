/**
 * Preload script: the only bridge between the sandboxed renderer and Electron.
 * Everything exposed here is mirrored by DesktopBridge in
 * apps/editor-web/src/platform.ts; keep the two in sync.
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("aaeDesktop", {
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
