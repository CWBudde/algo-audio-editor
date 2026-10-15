import type { AutosaveDeltaResult, AutosaveDocument } from "@aae/protocol";
import { type Delta, parseDelta, type RecordEntry, scanRecords } from "./format";
import type { Directory, SyncFile } from "./storage";

export const MANIFEST = "manifest.json";
const MANIFEST_TEMP = "manifest.tmp";
const MiB = 1024 * 1024;

/**
 * The last consistent state of a session. Every block its layout names lies
 * within the listed segment lengths; bytes appended after them are ignored.
 */
export interface Manifest {
  version: 1;
  /** Milliseconds since the epoch. */
  savedAt: number;
  nextBlockId: number;
  segments: { name: string; bytes: number }[];
  document: AutosaveDocument;
  layout: number[][];
}

export interface Location {
  segment: string;
  offset: number;
  bytes: number;
}

export interface StoreOptions {
  /** A segment rolls over once it holds this many bytes. */
  segmentBytes?: number;
  /** Compaction waits until this much is garbage, and more than is live. */
  compactMinDead?: number;
  now?: () => number;
  /** Lets other worker messages run during long copies. */
  pause?: () => Promise<void>;
}

const encoder = new TextEncoder();
const SEGMENT = /^seg-(\d+)\.bin$/;

function validManifest(value: unknown): value is Manifest {
  const manifest = value as Manifest;
  return (
    manifest?.version === 1 &&
    Number.isSafeInteger(manifest.nextBlockId) &&
    Number.isFinite(manifest.savedAt) &&
    Array.isArray(manifest.segments) &&
    manifest.segments.every(
      (segment) => SEGMENT.test(segment.name) && Number.isSafeInteger(segment.bytes),
    ) &&
    Array.isArray(manifest.layout) &&
    manifest.layout.every((channel) => Array.isArray(channel)) &&
    typeof manifest.document === "object" &&
    manifest.layout.length === manifest.document?.channels
  );
}

export async function readManifest(dir: Directory): Promise<Manifest | undefined> {
  if (!(await dir.names()).includes(MANIFEST)) return undefined;
  const file = await dir.open(MANIFEST, false);
  try {
    const bytes = new Uint8Array(file.getSize());
    file.read(bytes, 0);
    const manifest: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!validManifest(manifest)) throw new Error("The autosave manifest is invalid.");
    return manifest;
  } finally {
    file.close();
  }
}

function segmentNumber(name: string) {
  return Number(SEGMENT.exec(name)?.[1] ?? 0);
}

/**
 * One window's autosave session: append-only segment files of block records
 * and a manifest that is replaced in one step. A crash at any point leaves the
 * previous manifest and every block it names intact.
 */
export class SessionStore {
  private readonly dir: Directory;
  private readonly segmentBytes: number;
  private readonly compactMinDead: number;
  private readonly now: () => number;
  private readonly pause: () => Promise<void>;
  private readonly index = new Map<number, Location>();
  /** Blocks the written manifest names; they outlive a kernel free until replaced. */
  private committed = new Set<number>();
  private readonly freedCommitted = new Set<number>();
  private segments: { name: string; bytes: number }[] = [];
  private tail: SyncFile | undefined;
  private generation: number | undefined;
  private adopted = false;
  private nextBlockId = 1;
  private nextSegment = 1;
  private liveBytes = 0;
  private deadBytes = 0;
  private lastManifest = "";

  constructor(dir: Directory, options: StoreOptions = {}) {
    this.dir = dir;
    this.segmentBytes = options.segmentBytes ?? 256 * MiB;
    this.compactMinDead = options.compactMinDead ?? 64 * MiB;
    this.now = options.now ?? Date.now;
    this.pause = options.pause ?? (() => Promise.resolve());
  }

  /**
   * Continues a recovered session: the kernel has just installed its layout
   * with the same block IDs. Bytes past the manifest are a torn write.
   */
  static async adopt(
    dir: Directory,
    manifest: Manifest,
    index: Map<number, Location>,
    options?: StoreOptions,
  ): Promise<SessionStore> {
    const store = new SessionStore(dir, options);
    const listed = new Set(manifest.segments.map((segment) => segment.name));
    for (const name of await dir.names())
      if (SEGMENT.test(name) && !listed.has(name)) await dir.remove(name);
    store.segments = manifest.segments.map((segment) => ({ ...segment }));
    store.nextSegment = Math.max(0, ...store.segments.map((s) => segmentNumber(s.name))) + 1;
    store.nextBlockId = manifest.nextBlockId;
    store.committed = new Set(manifest.layout.flat());
    for (const [id, location] of index) {
      if (store.committed.has(id)) {
        store.index.set(id, location);
        store.liveBytes += location.bytes;
      } else store.deadBytes += location.bytes;
    }
    const last = store.segments.at(-1);
    if (last) {
      store.tail = await dir.open(last.name, false);
      store.tail.truncate(last.bytes);
      store.tail.flush();
    }
    store.adopted = true;
    return store;
  }

  /** Applies one kernel delta; true when it wrote a new manifest. */
  async apply(result: AutosaveDeltaResult, data: ArrayBuffer): Promise<boolean> {
    if (result.generation !== this.generation) {
      // A recovered session continues under the kernel's next generation.
      if (this.adopted) this.adopted = false;
      else await this.clear();
      this.generation = result.generation;
    }
    const delta = parseDelta(data, result.blocks);
    for (const id of delta.freed) {
      if (this.committed.has(id)) this.freedCommitted.add(id);
      else this.drop(id);
    }
    if (delta.entries.length) await this.append(delta);
    if (!result.complete) return false;
    if (result.document.channels === 0) {
      await this.clear();
      return false;
    }
    return this.commit(result.document, delta.layout ?? []);
  }

  /** Removes every file of the session; the next delta starts it over. */
  async clear() {
    this.close();
    for (const name of await this.dir.names()) await this.dir.remove(name);
    this.index.clear();
    this.committed.clear();
    this.freedCommitted.clear();
    this.segments = [];
    this.nextSegment = 1;
    this.nextBlockId = 1;
    this.liveBytes = 0;
    this.deadBytes = 0;
    this.lastManifest = "";
  }

  close() {
    this.tail?.close();
    this.tail = undefined;
  }

  stats() {
    return {
      liveBytes: this.liveBytes,
      deadBytes: this.deadBytes,
      segments: this.segments.map((segment) => segment.name),
    };
  }

  private drop(id: number) {
    const location = this.index.get(id);
    if (!location) return;
    this.index.delete(id);
    this.liveBytes -= location.bytes;
    this.deadBytes += location.bytes;
  }

  private async startSegment() {
    this.close();
    const name = `seg-${this.nextSegment++}.bin`;
    const tail = await this.dir.open(name, true);
    tail.truncate(0);
    this.tail = tail;
    const segment = { name, bytes: 0 };
    this.segments.push(segment);
    return { segment, tail };
  }

  private async append(delta: Delta) {
    let segment = this.segments.at(-1);
    let tail = this.tail;
    if (
      !segment ||
      !tail ||
      (segment.bytes > 0 && segment.bytes + delta.records.byteLength > this.segmentBytes)
    )
      ({ segment, tail } = await this.startSegment());
    const at = segment.bytes;
    if (tail.write(delta.records, at) !== delta.records.byteLength)
      throw new Error("An autosave segment write was incomplete.");
    tail.flush();
    for (const entry of delta.entries) {
      this.index.set(entry.id, {
        segment: segment.name,
        offset: at + entry.offset,
        bytes: entry.bytes,
      });
      this.liveBytes += entry.bytes;
      this.nextBlockId = Math.max(this.nextBlockId, entry.id + 1);
    }
    segment.bytes += delta.records.byteLength;
  }

  private async commit(document: AutosaveDocument, layout: number[][]): Promise<boolean> {
    const body = {
      version: 1 as const,
      nextBlockId: this.nextBlockId,
      segments: this.segments.map((segment) => ({ ...segment })),
      document,
      layout,
    };
    const key = JSON.stringify(body);
    if (key === this.lastManifest) return false;
    await this.writeManifest({ ...body, savedAt: this.now() });
    this.lastManifest = key;
    this.committed = new Set(layout.flat());
    for (const id of this.freedCommitted)
      if (!this.committed.has(id)) {
        this.freedCommitted.delete(id);
        this.drop(id);
      }
    if (this.deadBytes >= this.compactMinDead && this.deadBytes > this.liveBytes)
      await this.compact(document, layout);
    return true;
  }

  private async writeManifest(manifest: Manifest) {
    const bytes = encoder.encode(JSON.stringify(manifest));
    const file = await this.dir.open(MANIFEST_TEMP, true);
    try {
      file.truncate(0);
      if (file.write(bytes, 0) !== bytes.byteLength)
        throw new Error("The autosave manifest write was incomplete.");
      file.flush();
    } finally {
      file.close();
    }
    await this.dir.rename(MANIFEST_TEMP, MANIFEST);
  }

  /** Copies live records into a fresh segment, then retires the old ones. */
  private async compact(document: AutosaveDocument, layout: number[][]) {
    const old = this.segments;
    const sources = new Map<string, SyncFile>();
    this.segments = [];
    const { segment, tail } = await this.startSegment();
    try {
      let copied = 0;
      for (const [id, location] of this.index) {
        let source = sources.get(location.segment);
        if (!source) {
          source = await this.dir.open(location.segment, false);
          sources.set(location.segment, source);
        }
        const bytes = new Uint8Array(location.bytes);
        if (source.read(bytes, location.offset) !== bytes.byteLength)
          throw new Error("An autosave segment read was incomplete.");
        if (tail.write(bytes, segment.bytes) !== bytes.byteLength)
          throw new Error("An autosave segment write was incomplete.");
        this.index.set(id, {
          segment: segment.name,
          offset: segment.bytes,
          bytes: bytes.byteLength,
        });
        segment.bytes += bytes.byteLength;
        copied += bytes.byteLength;
        if (copied >= 32 * MiB) {
          copied = 0;
          await this.pause();
        }
      }
      tail.flush();
    } finally {
      for (const source of sources.values()) source.close();
    }
    this.deadBytes = 0;
    this.lastManifest = "";
    await this.commit(document, layout);
    for (const { name } of old) await this.dir.remove(name);
  }
}

export interface RecoverySink {
  begin(nextBlockId: number): void;
  /** Receives whole records; the view is reused after the call returns. */
  blocks(records: Uint8Array): void;
  progress(done: number, total: number): void;
}

/**
 * Streams the blocks a manifest names to the kernel in batches of at most
 * `batchBytes`. Segments are read once, in order; the returned index locates
 * every record within the manifest's lengths, for the adopting store.
 */
export async function readSession(
  dir: Directory,
  sink: RecoverySink,
  options: { batchBytes?: number; pause?: () => Promise<void> } = {},
): Promise<{ manifest: Manifest; index: Map<number, Location> }> {
  const manifest = await readManifest(dir);
  if (!manifest) throw new Error("The autosave has no complete snapshot.");
  const batchBytes = options.batchBytes ?? 32 * MiB;
  const live = new Set(manifest.layout.flat());
  const found = new Set<number>();
  const index = new Map<number, Location>();
  const total = manifest.segments.reduce((sum, segment) => sum + segment.bytes, 0);
  const batch = new Uint8Array(batchBytes);
  const chunk = new Uint8Array(batchBytes);
  let used = 0;
  let done = 0;
  const flush = async () => {
    if (!used) return;
    sink.blocks(batch.subarray(0, used));
    used = 0;
    sink.progress(done, total);
    await options.pause?.();
  };
  sink.begin(manifest.nextBlockId);
  for (const segment of manifest.segments) {
    const file = await dir.open(segment.name, false);
    try {
      if (file.getSize() < segment.bytes) throw new Error("An autosave segment is truncated.");
      let position = 0;
      let carried = 0;
      while (position < segment.bytes) {
        const length = Math.min(chunk.byteLength - carried, segment.bytes - position);
        if (length === 0) throw new Error("An autosave block exceeds the read buffer.");
        if (file.read(chunk.subarray(carried, carried + length), position) !== length)
          throw new Error("An autosave segment could not be read.");
        const base = position - carried;
        position += length;
        const filled = carried + length;
        const records: RecordEntry[] = [];
        const consumed = scanRecords(chunk.subarray(0, filled), (entry) => records.push(entry));
        for (const entry of records) {
          index.set(entry.id, {
            segment: segment.name,
            offset: base + entry.offset,
            bytes: entry.bytes,
          });
          if (!live.has(entry.id) || found.has(entry.id)) continue;
          found.add(entry.id);
          if (used + entry.bytes > batch.byteLength) await flush();
          batch.set(chunk.subarray(entry.offset, entry.offset + entry.bytes), used);
          used += entry.bytes;
        }
        done += consumed;
        carried = filled - consumed;
        chunk.copyWithin(0, consumed, filled);
      }
      if (carried) throw new Error("An autosave segment ends inside a block.");
    } finally {
      file.close();
    }
  }
  await flush();
  if (found.size !== live.size) throw new Error("The autosave is missing blocks.");
  sink.progress(total, total);
  return { manifest, index };
}
