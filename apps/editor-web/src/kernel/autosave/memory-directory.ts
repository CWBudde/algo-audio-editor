import type { Directory, SyncFile } from "./storage";

/**
 * An in-memory Directory with OPFS's exclusive-handle rule, for tests. The
 * tree survives a dropped store, which is how tests simulate a killed tab.
 */
export class MemoryDirectory implements Directory {
  readonly files = new Map<string, Uint8Array>();
  readonly directories = new Map<string, MemoryDirectory>();
  private readonly handles = new Set<string>();

  async open(name: string, create: boolean): Promise<SyncFile> {
    if (!this.files.has(name)) {
      if (!create) throw new DOMException(`${name} not found`, "NotFoundError");
      this.files.set(name, new Uint8Array());
    }
    if (this.handles.has(name))
      throw new DOMException(`${name} is already open`, "NoModificationAllowedError");
    this.handles.add(name);
    const files = this.files;
    let closed = false;
    const live = () => {
      if (closed) throw new DOMException("handle is closed", "InvalidStateError");
      return files.get(name) as Uint8Array;
    };
    return {
      getSize: () => live().byteLength,
      read(buffer, at) {
        const data = live().subarray(at, at + buffer.byteLength);
        buffer.set(data);
        return data.byteLength;
      },
      write(buffer, at) {
        const data = live();
        const next = new Uint8Array(Math.max(data.byteLength, at + buffer.byteLength));
        next.set(data);
        next.set(buffer, at);
        files.set(name, next);
        return buffer.byteLength;
      },
      truncate(size) {
        const next = new Uint8Array(size);
        next.set(live().subarray(0, size));
        files.set(name, next);
      },
      flush() {
        live();
      },
      close: () => {
        closed = true;
        this.handles.delete(name);
      },
    };
  }

  async rename(from: string, to: string) {
    const data = this.files.get(from);
    if (!data) throw new DOMException(`${from} not found`, "NotFoundError");
    if (this.handles.has(from) || this.handles.has(to))
      throw new DOMException("file is open", "NoModificationAllowedError");
    this.files.delete(from);
    this.files.set(to, data);
  }

  async remove(name: string) {
    if (this.handles.has(name))
      throw new DOMException("file is open", "NoModificationAllowedError");
    this.files.delete(name);
  }

  async names() {
    return [...this.files.keys(), ...this.directories.keys()];
  }

  async directory(name: string, create: boolean): Promise<Directory> {
    let directory = this.directories.get(name);
    if (!directory) {
      if (!create) throw new DOMException(`${name} not found`, "NotFoundError");
      directory = new MemoryDirectory();
      this.directories.set(name, directory);
    }
    return directory;
  }

  async removeDirectory(name: string) {
    this.directories.delete(name);
  }

  /** Drops every open handle, as a killed worker does. */
  crash() {
    this.handles.clear();
    for (const directory of this.directories.values()) directory.crash();
  }

  /** True while any handle in this directory is open. */
  busy() {
    return this.handles.size > 0;
  }
}
