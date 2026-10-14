// @vitest-environment node
import type { AutosaveDocument, KernelMethod } from "@aae/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scanRecords } from "./format";
import { MemoryDirectory } from "./memory-directory";
import { readManifest } from "./store";
import {
  type AutosaveHost,
  type AutosaveStatus,
  DEBOUNCE_MS,
  MAX_LATENCY_MS,
  WorkerAutosave,
} from "./worker-autosave";

/** Web Locks for one origin, shared by every fake window. */
class FakeLocks {
  readonly held = new Set<string>();
  async request(
    name: string,
    options: LockOptions,
    callback: (lock: Lock | null) => unknown,
  ): Promise<unknown> {
    if (this.held.has(name)) {
      if (!options.ifAvailable) throw new Error("FakeLocks only supports ifAvailable");
      return callback(null);
    }
    this.held.add(name);
    try {
      return await callback({ name, mode: "exclusive" });
    } finally {
      this.held.delete(name);
    }
  }
  async query(): Promise<LockManagerSnapshot> {
    return { held: [...this.held].map((name) => ({ name, mode: "exclusive" })), pending: [] };
  }
  /** A killed window's locks are released by the browser. */
  releaseAll(id: string) {
    for (const name of [...this.held]) if (name.endsWith(id)) this.held.delete(name);
  }
}

function documentState(dirty: boolean): AutosaveDocument {
  return {
    name: "take.wav",
    tags: {},
    sampleRate: 48000,
    channels: 1,
    frames: 4,
    nextAnchorId: 1,
    markers: [],
    regions: [],
    chunks: [],
    sourceFormat: "wav",
    sourceBitDepth: 16,
    sourceFloat: false,
    selection: { start: 0, end: 0, channelMask: 1 },
    dirty,
  };
}

/**
 * A kernel holding one mono document of one-frame blocks. Every delta writes
 * the blocks the store has not seen and the full layout, like autosave.go.
 */
class FakeKernel {
  generation = 1;
  layout: number[] = [1];
  dirty = false;
  written = new Set<number>();
  calls: string[] = [];
  recovered: { nextBlockId?: number; blocks: number[]; layout?: number[][] } = { blocks: [] };

  call(method: KernelMethod, params?: unknown, input?: ArrayBuffer | Uint8Array): unknown {
    this.calls.push(method);
    if (method === "autosave.delta") {
      const pending = [...new Set(this.layout)].filter((id) => !this.written.has(id));
      const words = [0, 1, this.layout.length, ...this.layout, pending.length];
      const data = new ArrayBuffer(words.length * 4 + pending.length * 12);
      const view = new DataView(data);
      words.forEach((word, i) => {
        view.setUint32(i * 4, word, true);
      });
      pending.forEach((id, i) => {
        const at = words.length * 4 + i * 12;
        view.setUint32(at, id, true);
        view.setUint32(at + 4, 1, true);
        view.setFloat32(at + 8, id, true);
        this.written.add(id);
      });
      return {
        generation: this.generation,
        complete: true,
        blocks: pending.length,
        freed: 0,
        pending: 0,
        document: documentState(this.dirty),
        dataBytes: data.byteLength,
        data,
      };
    }
    if (method === "recovery.begin")
      this.recovered = { nextBlockId: (params as { nextBlockId: number }).nextBlockId, blocks: [] };
    if (method === "recovery.blocks")
      scanRecords(input as Uint8Array, ({ id }) => this.recovered.blocks.push(id));
    if (method === "recovery.finish") {
      const view = new DataView(input as ArrayBuffer);
      this.recovered.layout = [
        Array.from({ length: view.getUint32(4, true) }, (_, i) => view.getUint32(8 + i * 4, true)),
      ];
      this.layout = this.recovered.layout[0];
      this.written = new Set(this.recovered.blocks);
      this.generation++;
      return { documentId: "doc-9", name: "take.wav" };
    }
    return {};
  }
}

interface EditorWindow {
  autosave: WorkerAutosave;
  kernel: FakeKernel;
  statuses: AutosaveStatus[];
}

const root = new MemoryDirectory();
let locks: FakeLocks;
let ids = 0;

function openWindow(): EditorWindow {
  const kernel = new FakeKernel();
  const statuses: AutosaveStatus[] = [];
  const host: AutosaveHost = {
    call: (method, params, input) => kernel.call(method, params, input),
    yieldTask: () => Promise.resolve(),
    playing: () => false,
    publish: (status) => statuses.push(status),
    root: async () => root,
    locks: locks as unknown as AutosaveHost["locks"],
    now: () => Date.now(),
    randomId: () => `session-${++ids}`,
  };
  return { autosave: new WorkerAutosave(host), kernel, statuses };
}

async function settle(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
}

function deltas(window: EditorWindow) {
  return window.kernel.calls.filter((call) => call === "autosave.delta").length;
}

describe("WorkerAutosave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    root.directories.clear();
    locks = new FakeLocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("saves a new document at once and edits within the latency bound", async () => {
    const window = openWindow();
    const id = await window.autosave.enable();
    await settle();
    const session = root.directories.get(id) as MemoryDirectory;
    expect((await readManifest(session))?.layout).toEqual([[1]]);
    expect(window.statuses.at(-1)).toMatchObject({ state: "saved", dirty: false });

    window.kernel.layout = [1, 2];
    window.kernel.dirty = true;
    window.autosave.touch("edit.apply");
    await settle(DEBOUNCE_MS - 1);
    expect((await readManifest(session))?.layout).toEqual([[1]]);
    await settle(1);
    expect((await readManifest(session))?.layout).toEqual([[1, 2]]);

    // Continuous editing postpones the debounce, but not past the bound.
    window.kernel.layout = [1, 2, 3];
    for (let elapsed = 0; elapsed < MAX_LATENCY_MS; elapsed += 500) {
      window.autosave.touch("selection.set");
      await settle(500);
    }
    expect((await readManifest(session))?.layout).toEqual([[1, 2, 3]]);
    // Reads never schedule a save.
    const before = deltas(window);
    window.autosave.touch("peaks.get");
    await settle(MAX_LATENCY_MS);
    expect(deltas(window)).toBe(before);
  });

  it("offers only dirty sessions of windows that died, and deletes the rest", async () => {
    const crashed = openWindow();
    crashed.kernel.dirty = true;
    const crashedId = await crashed.autosave.enable();
    await settle();
    const closed = openWindow();
    closed.kernel.dirty = true;
    const closedId = await closed.autosave.enable();
    await settle();
    const clean = openWindow();
    const cleanId = await clean.autosave.enable();
    await settle();
    const alive = openWindow();
    alive.kernel.dirty = true;
    const aliveId = await alive.autosave.enable();
    await settle();
    for (const id of [crashedId, closedId, cleanId]) locks.releaseAll(id);
    root.crash();

    const current = openWindow();
    await current.autosave.enable();
    const { sessions, removed } = await current.autosave.list([closedId]);
    expect(sessions.map((session) => session.sessionId)).toEqual([crashedId]);
    expect(sessions[0]).toMatchObject({ name: "take.wav", channels: 1, frames: 4, bytes: 12 });
    expect(removed.sort()).toEqual([cleanId, closedId].sort());
    expect(root.directories.has(aliveId)).toBe(true);
  });

  it("recovers a crashed session and continues it as its own", async () => {
    const crashed = openWindow();
    crashed.kernel.layout = [1, 2, 2];
    crashed.kernel.dirty = true;
    const crashedId = await crashed.autosave.enable();
    await settle();
    locks.releaseAll(crashedId);
    root.crash();

    const current = openWindow();
    const ownId = await current.autosave.enable();
    await settle();
    const progress: number[] = [];
    const { sessionId } = await current.autosave.recover(crashedId, (done) => progress.push(done));
    expect(sessionId).toBe(crashedId);
    expect(current.kernel.recovered).toEqual({
      nextBlockId: 3,
      blocks: [1, 2],
      layout: [[1, 2, 2]],
    });
    expect(progress.at(-1)).toBe(24);
    expect(root.directories.has(ownId)).toBe(false);
    expect(locks.held.has(`aae-autosave:${crashedId}`)).toBe(true);

    // The adopted session takes new blocks without rewriting recovered ones.
    await settle();
    current.kernel.layout = [1, 2, 3];
    current.autosave.touch("edit.apply");
    await settle(DEBOUNCE_MS);
    const session = root.directories.get(crashedId) as MemoryDirectory;
    expect((await readManifest(session))?.layout).toEqual([[1, 2, 3]]);
    expect(session.files.get("seg-1.bin")?.byteLength).toBe(36);
    await expect(current.autosave.discard(crashedId)).rejects.toThrow(/own autosave/);
  });

  it("refuses sessions another window holds and discards on request", async () => {
    const other = openWindow();
    other.kernel.dirty = true;
    const otherId = await other.autosave.enable();
    await settle();
    const current = openWindow();
    await current.autosave.enable();
    await expect(current.autosave.recover(otherId, () => {})).rejects.toThrow(/another window/);
    await expect(current.autosave.discard(otherId)).rejects.toThrow(/another window/);
    locks.releaseAll(otherId);
    root.crash();
    await current.autosave.discard(otherId);
    expect(root.directories.has(otherId)).toBe(false);
  });

  it("reports a failed save and retries on the next change", async () => {
    const window = openWindow();
    await window.autosave.enable();
    await settle();
    const call = window.kernel.call.bind(window.kernel);
    window.kernel.call = (method, ...rest) => {
      if (method === "autosave.delta") throw new Error("QuotaExceededError");
      return call(method, ...rest);
    };
    window.autosave.touch("edit.apply");
    await settle(DEBOUNCE_MS);
    expect(window.statuses.at(-1)).toMatchObject({ state: "error", error: "QuotaExceededError" });
    expect(window.statuses.at(-1)?.sessionId).toMatch(/^session-/);
    window.kernel.call = call;
    window.autosave.touch("edit.apply");
    await settle(DEBOUNCE_MS);
    expect(window.statuses.at(-1)).toMatchObject({ state: "saved" });
  });
});
