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

/** A pinned speech model file from the go-pocket-tts catalog. */
export interface SpeechModelFile {
  /** Revision-pinned https://huggingface.co/<repo>/resolve/<40-hex revision>/<file> URL. */
  url: string;
  /** Lower-case hex SHA-256 of the file. */
  sha256: string;
  size: number;
  /** Slash-separated catalog path below the model root, e.g. "german/voices/juergen.safetensors". */
  path: string;
}
export interface SpeechDownloadProgress {
  /** Catalog path of the file being received. */
  path: string;
  /** Bytes received for all requested files so far, and their total. */
  done: number;
  total: number;
}

/** API exposed by the Electron preload script (apps/desktop/src/preload.ts). */
export interface DesktopBridge {
  openFile(): Promise<NativeFile | null>;
  saveFile(name: string, extensions: string[]): Promise<NativeFile | null>;
  readFile(id: string): Promise<ArrayBuffer>;
  writeFile(id: string, data: ArrayBuffer): Promise<void>;
  didOpenFile(id: string): Promise<void>;
  releaseFile(id: string): Promise<void>;
  pickBatchDirectory?(): Promise<NativeFile | null>;
  writeBatchFile?(id: string, name: string, data: ArrayBuffer): Promise<void>;
  releaseBatchDirectory?(id: string): Promise<void>;
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
  /** Downloads missing or corrupt files into userData/speech-models (checked by size and
   * SHA-256, written atomically) and resolves with the base URL that serves them, e.g.
   * "app://editor/speech-models/". Rejects with "cancelled" after cancelSpeechModels. */
  ensureSpeechModels?(files: SpeechModelFile[]): Promise<string>;
  cancelSpeechModels?(): Promise<void>;
  /** Deletes every downloaded speech model. */
  removeSpeechModels?(): Promise<void>;
  /** Bytes the downloaded speech models occupy. */
  speechModelsUsage?(): Promise<number>;
  onSpeechModelsProgress?(callback: (progress: SpeechDownloadProgress) => void): () => void;
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
