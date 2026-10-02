/**
 * Preload script: the only bridge between the sandboxed renderer and Electron.
 * Everything exposed here is mirrored by DesktopBridge in
 * apps/editor-web/src/platform.ts; keep the two in sync.
 */
import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("aaeDesktop", {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
