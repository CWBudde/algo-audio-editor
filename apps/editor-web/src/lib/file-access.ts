import type { ExportResult } from "@aae/protocol";
import { AUDIO_TYPES } from "@/lib/audio-codecs";
import { desktopBridge, type NativeFile } from "@/platform";

const nativeFiles = new WeakMap<File, NativeFile>();
export async function readNativeFile(selected: NativeFile): Promise<File> {
  const bridge = desktopBridge();
  if (!bridge) throw new Error("Desktop file access unavailable");
  try {
    const data = await bridge.readFile(selected.id);
    const file = new File([data], selected.name);
    nativeFiles.set(file, selected);
    return file;
  } catch (error) {
    await bridge.releaseFile(selected.id).catch(() => {});
    throw error;
  }
}
export async function finishNativeOpen(file: File, success: boolean) {
  const selected = nativeFiles.get(file);
  if (!selected) return;
  nativeFiles.delete(file);
  const bridge = desktopBridge();
  if (success) await bridge?.didOpenFile(selected.id);
  else await bridge?.releaseFile(selected.id);
}

interface WritableFile {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

interface AudioFileHandle {
  getFile(): Promise<File>;
  createWritable(): Promise<WritableFile>;
}

interface AudioPickerOptions {
  types: { description: string; accept: Record<string, string[]> }[];
}

declare global {
  interface Window {
    showOpenFilePicker?: (
      options: AudioPickerOptions & { multiple: boolean },
    ) => Promise<AudioFileHandle[]>;
    showSaveFilePicker?: (
      options: AudioPickerOptions & { suggestedName: string },
    ) => Promise<AudioFileHandle>;
  }
}

const WAV_TYPES = [{ description: "WAV audio", accept: { "audio/wav": [".wav"] } }];

export function isFileDialogCancelled(error: unknown): boolean {
  return hasErrorName(error, "AbortError");
}

function hasErrorName(error: unknown, name: string): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === name;
}

/** Cancellation ends the action; missing or unsupported pickers use the input. */
export async function chooseAudioFile(fallback: () => void): Promise<File | undefined> {
  const bridge = desktopBridge();
  if (bridge) {
    const selected = await bridge.openFile();
    return selected ? readNativeFile(selected) : undefined;
  }
  if (!window.showOpenFilePicker) {
    fallback();
    return undefined;
  }
  try {
    const [handle] = await window.showOpenFilePicker({ multiple: false, types: AUDIO_TYPES });
    return handle?.getFile();
  } catch (error) {
    if (isFileDialogCancelled(error)) return undefined;
    if (hasErrorName(error, "NotSupportedError")) {
      fallback();
      return undefined;
    }
    throw error;
  }
}

export interface SaveTarget {
  write(result: ExportResult): Promise<void>;
  dispose?(): Promise<void>;
}

/** Ask during the user gesture, before waiting for the kernel to export. */
export async function chooseSaveTarget(
  name: string,
  types: AudioPickerOptions["types"] = WAV_TYPES,
): Promise<SaveTarget | undefined> {
  const bridge = desktopBridge();
  if (bridge) {
    const extensions = [
      ...new Set(
        types.flatMap((type) =>
          Object.values(type.accept)
            .flat()
            .map((ext) => ext.replace(/^\./, "")),
        ),
      ),
    ];
    const selected = await bridge.saveFile(name, extensions);
    if (!selected) return undefined;
    return {
      async write(result) {
        await bridge.writeFile(selected.id, result.data);
      },
      async dispose() {
        await bridge.releaseFile(selected.id).catch(() => {});
      },
    };
  }
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: name, types });
      return {
        async write(result) {
          const writable = await handle.createWritable();
          try {
            await writable.write(new Blob([result.data], { type: result.mimeType }));
            await writable.close();
          } catch (error) {
            await writable.abort?.().catch(() => undefined);
            throw error;
          }
        },
      };
    } catch (error) {
      if (isFileDialogCancelled(error)) return undefined;
      if (!hasErrorName(error, "NotSupportedError")) throw error;
    }
  }
  return {
    async write(result) {
      const url = URL.createObjectURL(new Blob([result.data], { type: result.mimeType }));
      const link = document.createElement("a");
      link.href = url;
      link.download = result.name;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    },
  };
}
