// @vitest-environment node
import type { AutosaveDeltaResult, AutosaveDocument } from "@aae/protocol";
import { describe, expect, it } from "vitest";
import { encodeLayout, parseDelta, scanRecords } from "./format";
import { MemoryDirectory } from "./memory-directory";
import { MANIFEST, readManifest, readSession, SessionStore, type StoreOptions } from "./store";

interface Block {
  id: number;
  frames: number;
}

function documentState(channels: number, frames = 0, dirty = true): AutosaveDocument {
  return {
    name: "take.wav",
    tags: {},
    sampleRate: 48000,
    channels,
    frames,
    nextAnchorId: 1,
    markers: [],
    regions: [],
    chunks: [],
    sourceFormat: "wav",
    sourceBitDepth: 24,
    sourceFloat: false,
    selection: { start: 0, end: 0, channelMask: 1 },
    dirty,
  };
}

/** Encodes a delta exactly as engine/autosave.go does. Samples repeat the ID. */
function delta(
  generation: number,
  blocks: Block[],
  options: { freed?: number[]; layout?: number[][]; document?: AutosaveDocument } = {},
): { result: AutosaveDeltaResult; data: ArrayBuffer } {
  const freed = options.freed ?? [];
  const layout = options.layout;
  const words = [freed.length, ...freed, layout?.length ?? 0];
  for (const channel of layout ?? []) words.push(channel.length, ...channel);
  words.push(blocks.length);
  const recordBytes = blocks.reduce((sum, block) => sum + 8 + block.frames * 4, 0);
  const data = new ArrayBuffer(words.length * 4 + recordBytes);
  const view = new DataView(data);
  words.forEach((word, i) => {
    view.setUint32(i * 4, word, true);
  });
  let offset = words.length * 4;
  for (const block of blocks) {
    view.setUint32(offset, block.id, true);
    view.setUint32(offset + 4, block.frames, true);
    for (let i = 0; i < block.frames; i++) view.setFloat32(offset + 8 + i * 4, block.id, true);
    offset += 8 + block.frames * 4;
  }
  const document = options.document ?? documentState(layout?.length ?? 1);
  return {
    result: {
      generation,
      complete: layout !== undefined || document.channels === 0,
      blocks: blocks.length,
      freed: freed.length,
      pending: 0,
      document,
      dataBytes: data.byteLength,
      data,
    },
    data,
  };
}

async function apply(store: SessionStore, value: ReturnType<typeof delta>) {
  return store.apply(value.result, value.data);
}

/**
 * Recovers into a record map, as the kernel's recovery.blocks would. Recovery
 * only follows a killed tab, whose handles the browser has released.
 */
async function recover(directory: MemoryDirectory, batchBytes = 4096) {
  directory.crash();
  const records = new Map<number, number[]>();
  const progress: number[] = [];
  let next = 0;
  const session = await readSession(
    directory,
    {
      begin: (nextBlockId) => {
        next = nextBlockId;
      },
      blocks: (bytes) => {
        expect(bytes.byteLength).toBeLessThanOrEqual(batchBytes);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        scanRecords(bytes, ({ id, offset, bytes: size }) => {
          expect(records.has(id)).toBe(false);
          const samples = [];
          for (let at = offset + 8; at < offset + size; at += 4)
            samples.push(view.getFloat32(at, true));
          records.set(id, samples);
        });
      },
      progress: (done) => progress.push(done),
    },
    { batchBytes },
  );
  return { ...session, records, progress, next };
}

const blocks = (ids: number[], frames = 16) => ids.map((id) => ({ id, frames }));

function createStore(directory: MemoryDirectory, options: StoreOptions = {}) {
  let now = 1000;
  return new SessionStore(directory, { now: () => now++, ...options });
}

describe("autosave delta format", () => {
  it("parses freed IDs, layout and records, and encodes a layout", () => {
    const { data } = delta(1, blocks([3, 4], 2), { freed: [1, 2], layout: [[3], [4]] });
    const parsed = parseDelta(data, 2);
    expect(parsed.freed).toEqual([1, 2]);
    expect(parsed.layout).toEqual([[3], [4]]);
    expect(parsed.entries.map((entry) => entry.id)).toEqual([3, 4]);
    expect(parsed.records.byteLength).toBe(2 * (8 + 8));
    expect(new Uint32Array(encodeLayout([[3, 3], [4]]))).toEqual(
      new Uint32Array([2, 2, 3, 3, 1, 4]),
    );
  });

  it("rejects truncated, miscounted and invalid deltas", () => {
    const { data } = delta(1, blocks([3]), { layout: [[3]] });
    expect(() => parseDelta(data.slice(0, data.byteLength - 1), 1)).toThrow(/malformed/);
    expect(() => parseDelta(data, 2)).toThrow(/count/);
    expect(() => parseDelta(data.slice(0, 6), 1)).toThrow(/truncated/);
    const zero = delta(1, [{ id: 0, frames: 1 }]).data;
    expect(() => parseDelta(zero, 1)).toThrow(/invalid/);
  });
});

describe("SessionStore", () => {
  it("writes each block once and recovers the committed layout", async () => {
    const directory = new MemoryDirectory();
    const store = createStore(directory);
    expect(await apply(store, delta(1, blocks([1, 2]), { layout: [[1, 2]] }))).toBe(true);
    expect(await apply(store, delta(1, [], { layout: [[1, 2]] }))).toBe(false);
    expect(await apply(store, delta(1, blocks([3]), { layout: [[1, 3, 3]] }))).toBe(true);
    const manifest = await readManifest(directory);
    expect(manifest).toMatchObject({ nextBlockId: 4, layout: [[1, 3, 3]], savedAt: 1001 });
    expect(manifest?.segments).toEqual([{ name: "seg-1.bin", bytes: 3 * (8 + 64) }]);

    const recovered = await recover(directory, 2 * (8 + 64));
    expect([...recovered.records.keys()].sort()).toEqual([1, 3]);
    expect(recovered.records.get(3)).toEqual(Array(16).fill(3));
    expect(recovered.next).toBe(4);
    expect(recovered.progress.at(-1)).toBe(3 * 72);
    expect(recovered.index.size).toBe(3);
  });

  it("keeps the previous snapshot until a later delta is complete", async () => {
    const directory = new MemoryDirectory();
    const store = createStore(directory);
    await apply(store, delta(1, blocks([1]), { layout: [[1]] }));
    // An edit whose writes are interrupted: blocks without a layout.
    await apply(store, delta(1, blocks([2, 3]), { freed: [1] }));
    directory.crash();
    const recovered = await recover(directory);
    expect([...recovered.records.keys()]).toEqual([1]);
    expect(recovered.manifest.layout).toEqual([[1]]);
  });

  it("ignores a torn write after the manifest and truncates it on adoption", async () => {
    const directory = new MemoryDirectory();
    const store = createStore(directory);
    await apply(store, delta(1, blocks([1]), { layout: [[1]] }));
    const segment = directory.files.get("seg-1.bin") as Uint8Array;
    const torn = new Uint8Array(segment.byteLength + 13);
    torn.set(segment);
    torn.set([9, 0, 0, 0, 255, 0, 0, 0], segment.byteLength);
    directory.files.set("seg-1.bin", torn);
    directory.files.set("seg-2.bin", new Uint8Array(40));
    directory.crash();

    const recovered = await recover(directory);
    expect([...recovered.records.keys()]).toEqual([1]);
    const adopted = await SessionStore.adopt(directory, recovered.manifest, recovered.index);
    expect(directory.files.get("seg-1.bin")?.byteLength).toBe(72);
    expect(directory.files.has("seg-2.bin")).toBe(false);
    // The kernel continues the session under a new generation with new IDs.
    expect(await apply(adopted, delta(7, blocks([2]), { layout: [[1, 2]] }))).toBe(true);
    adopted.close();
    const again = await recover(directory);
    expect([...again.records.keys()].sort()).toEqual([1, 2]);
  });

  it("keeps freed blocks the manifest names, then compacts garbage", async () => {
    const directory = new MemoryDirectory();
    const store = createStore(directory, { compactMinDead: 100 });
    await apply(store, delta(1, blocks([1, 2, 3]), { layout: [[1, 2, 3]] }));
    // Freed while still named: a crash before the next manifest must recover them.
    await apply(store, delta(1, blocks([4]), { freed: [1, 2, 3] }));
    expect(store.stats().deadBytes).toBe(0);
    const before = await recover(directory);
    expect([...before.records.keys()].sort()).toEqual([1, 2, 3]);

    // Three dead records outweigh the live one: compaction rewrites it alone.
    await apply(store, delta(1, [], { layout: [[4, 4]] }));
    expect(store.stats()).toEqual({ liveBytes: 72, deadBytes: 0, segments: ["seg-2.bin"] });
    expect(directory.files.has("seg-1.bin")).toBe(false);
    const after = await recover(directory);
    expect([...after.records.keys()]).toEqual([4]);
    expect(after.records.get(4)).toEqual(Array(16).fill(4));
  });

  it("rolls segments over and recovers across them", async () => {
    const directory = new MemoryDirectory();
    const store = createStore(directory, { segmentBytes: 100 });
    for (const id of [1, 2, 3])
      await apply(store, delta(1, blocks([id]), { layout: [[1, 2, 3].slice(0, id)] }));
    expect(store.stats().segments).toEqual(["seg-1.bin", "seg-2.bin", "seg-3.bin"]);
    const recovered = await recover(directory);
    expect([...recovered.records.keys()].sort()).toEqual([1, 2, 3]);
  });

  it("starts over for a new document and clears for an empty editor", async () => {
    const directory = new MemoryDirectory();
    const store = createStore(directory);
    await apply(store, delta(1, blocks([1, 2]), { layout: [[1, 2]] }));
    await apply(store, delta(2, blocks([1]), { layout: [[1]] }));
    expect((await directory.names()).sort()).toEqual([MANIFEST, "seg-1.bin"]);
    expect((await readManifest(directory))?.segments).toEqual([{ name: "seg-1.bin", bytes: 72 }]);
    await apply(store, delta(3, [], { document: documentState(0) }));
    expect(await directory.names()).toEqual([]);
    expect(directory.busy()).toBe(false);
  });

  it("rejects a manifest whose blocks are missing", async () => {
    const directory = new MemoryDirectory();
    const store = createStore(directory);
    await apply(store, delta(1, blocks([1]), { layout: [[1]] }));
    store.close();
    directory.files.set("seg-1.bin", new Uint8Array());
    await expect(recover(directory)).rejects.toThrow(/truncated/);
    directory.files.delete(MANIFEST);
    await expect(recover(directory)).rejects.toThrow(/no complete snapshot/);
  });
});
