/// <reference lib="webworker" />
/**
 * The few file operations the autosave store needs, over OPFS synchronous
 * access handles. They only exist in dedicated workers, which is where the
 * kernel and its store run. Tests substitute an in-memory directory.
 */

export interface SyncFile {
  getSize(): number;
  read(buffer: Uint8Array, at: number): number;
  write(buffer: Uint8Array, at: number): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

export interface Directory {
  /** Opens a file for exclusive synchronous access. */
  open(name: string, create: boolean): Promise<SyncFile>;
  /** Replaces `to` with `from` in one step. */
  rename(from: string, to: string): Promise<void>;
  /** Removing a missing entry is not an error. */
  remove(name: string): Promise<void>;
  names(): Promise<string[]>;
  directory(name: string, create: boolean): Promise<Directory>;
  removeDirectory(name: string): Promise<void>;
}

/** Chromium's FileSystemHandle.move; not yet in TypeScript's DOM library. */
interface MovableFileHandle extends FileSystemFileHandle {
  move(name: string): Promise<void>;
}

function notFound(error: unknown) {
  return error instanceof DOMException && error.name === "NotFoundError";
}

class OpfsDirectory implements Directory {
  private readonly handle: FileSystemDirectoryHandle;

  constructor(handle: FileSystemDirectoryHandle) {
    this.handle = handle;
  }

  async open(name: string, create: boolean): Promise<SyncFile> {
    const file = await this.handle.getFileHandle(name, { create });
    const access = await file.createSyncAccessHandle();
    return {
      getSize: () => access.getSize(),
      read: (buffer, at) => access.read(buffer, { at }),
      write: (buffer, at) => access.write(buffer, { at }),
      truncate: (size) => access.truncate(size),
      flush: () => access.flush(),
      close: () => access.close(),
    };
  }

  async rename(from: string, to: string) {
    const file = (await this.handle.getFileHandle(from)) as MovableFileHandle;
    await file.move(to);
  }

  async remove(name: string) {
    try {
      await this.handle.removeEntry(name);
    } catch (error) {
      if (!notFound(error)) throw error;
    }
  }

  async names() {
    const names: string[] = [];
    for await (const name of this.handle.keys()) names.push(name);
    return names;
  }

  async directory(name: string, create: boolean): Promise<Directory> {
    return new OpfsDirectory(await this.handle.getDirectoryHandle(name, { create }));
  }

  async removeDirectory(name: string) {
    try {
      await this.handle.removeEntry(name, { recursive: true });
    } catch (error) {
      if (!notFound(error)) throw error;
    }
  }
}

/**
 * The autosave root. Pages shares its origin with other projects, so the
 * editor keeps its files under its own name.
 */
export async function autosaveRoot(): Promise<Directory> {
  if (typeof navigator.storage?.getDirectory !== "function")
    throw new Error("This browser has no origin private file system.");
  const root = new OpfsDirectory(await navigator.storage.getDirectory());
  return (await root.directory("algo-audio-editor", true)).directory("autosave", true);
}
