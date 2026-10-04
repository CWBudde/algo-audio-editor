import type { ExportResult } from "@aae/protocol";
import { desktopBridge } from "@/platform";
import { isFileDialogCancelled } from "./file-access";

interface BatchWritable {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}
interface BatchFileHandle {
  createWritable(): Promise<BatchWritable>;
}
export interface BatchDirectoryHandle {
  name: string;
  getFileHandle(name: string, options: { create: boolean }): Promise<BatchFileHandle>;
}
declare global {
  interface Window {
    showDirectoryPicker?: (options: { mode: "readwrite" }) => Promise<BatchDirectoryHandle>;
  }
}

export interface BatchDestination {
  mode: "folder" | "downloads";
  label: string;
  preflight(names: readonly string[]): Promise<void>;
  write(result: ExportResult): Promise<void>;
  dispose?(): Promise<void>;
}

async function requireAbsent(directory: BatchDirectoryHandle, name: string): Promise<void> {
  try {
    await directory.getFileHandle(name, { create: false });
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return;
    throw error;
  }
  throw new Error(`Output already exists: ${name}`);
}

export function batchFolderAvailable(): boolean {
  const bridge = desktopBridge();
  return bridge
    ? Boolean(bridge.pickBatchDirectory && bridge.writeBatchFile && bridge.releaseBatchDirectory)
    : Boolean(window.showDirectoryPicker);
}

/** Obtain a directory grant during the button's user gesture, never from a worker. */
export async function chooseBatchDirectory(): Promise<BatchDestination | undefined> {
  const bridge = desktopBridge();
  if (bridge) {
    if (!bridge.pickBatchDirectory || !bridge.writeBatchFile || !bridge.releaseBatchDirectory)
      throw new Error("Batch output folders are unavailable in this desktop build.");
    const selected = await bridge.pickBatchDirectory();
    if (!selected) return;
    return {
      mode: "folder",
      label: selected.name,
      async preflight() {},
      async write(result) {
        await bridge.writeBatchFile?.(selected.id, result.name, result.data);
      },
      async dispose() {
        await bridge.releaseBatchDirectory?.(selected.id);
      },
    };
  }
  if (!window.showDirectoryPicker) return;
  try {
    const directory = await window.showDirectoryPicker({ mode: "readwrite" });
    return {
      mode: "folder",
      label: directory.name,
      async preflight(names) {
        for (const name of names) await requireAbsent(directory, name);
      },
      async write(result) {
        await requireAbsent(directory, result.name);
        const handle = await directory.getFileHandle(result.name, { create: true });
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
    if (isFileDialogCancelled(error)) return;
    throw error;
  }
}

export function batchDownloads(): BatchDestination {
  return {
    mode: "downloads",
    label: "Browser downloads",
    async preflight() {},
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
