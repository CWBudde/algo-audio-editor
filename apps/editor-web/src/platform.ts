export interface NativeFile {
  id: string;
  name: string;
}
export interface NativeMenuItem {
  id?: string;
  label?: string;
  enabled?: boolean;
  accelerator?: string;
  separator?: boolean;
  children?: NativeMenuItem[];
}
export interface DesktopState {
  dirty: boolean;
  busy: boolean;
  name?: string;
}

/** API exposed by the Electron preload script (apps/desktop/src/preload.ts). */
export interface DesktopBridge {
  openFile(): Promise<NativeFile | null>;
  saveFile(name: string, extensions: string[]): Promise<NativeFile | null>;
  readFile(id: string): Promise<ArrayBuffer>;
  writeFile(id: string, data: ArrayBuffer): Promise<void>;
  didOpenFile(id: string): Promise<void>;
  releaseFile(id: string): Promise<void>;
  takeOpenFiles(): Promise<NativeFile[]>;
  onOpenFiles(callback: () => void): () => void;
  setMenu(items: NativeMenuItem[]): Promise<void>;
  onCommand(callback: (id: string) => void): () => void;
  setDocumentState(state: DesktopState): Promise<void>;
  onSaveBeforeClose(callback: (request: string) => void): () => void;
  completeClose(request: string, saved: boolean): Promise<void>;
  confirmReplace(name: string): Promise<boolean>;
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
