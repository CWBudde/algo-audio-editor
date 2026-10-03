/** API exposed by the Electron preload script (apps/desktop/src/preload.ts). */
export interface DesktopBridge {
  deleteEffectIR?(id: string): Promise<void>;
  loadEffectIR?(id: string): Promise<ArrayBuffer>;
  saveEffectIR?(id: string, data: ArrayBuffer): Promise<void>;
  loadEffectPresets?(): Promise<string | null>;
  saveEffectPresets?(data: string): Promise<void>;
  platform: string;
  versions: { electron: string; chrome: string; node: string };
}

declare global {
  interface Window {
    aaeDesktop?: DesktopBridge;
  }
}

/** Present only when running inside the Electron shell. */
export function desktopBridge(): DesktopBridge | undefined {
  return typeof window === "undefined" ? undefined : window.aaeDesktop;
}
