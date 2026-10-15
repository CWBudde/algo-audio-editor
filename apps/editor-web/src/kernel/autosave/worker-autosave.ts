import type { AutosaveDeltaResult, DocumentInfoResult, KernelMethod } from "@aae/protocol";
import { encodeLayout } from "./format";
import type { Directory } from "./storage";
import { readManifest, readSession, SessionStore } from "./store";
import type { AutosaveStatus, RecoverableSession } from "./types";

export type { AutosaveStatus, RecoverableSession } from "./types";

export interface AutosaveHost {
  /** Calls the kernel synchronously; bulk results carry `data`. */
  call(method: KernelMethod, params?: unknown, input?: ArrayBuffer | Uint8Array): unknown;
  yieldTask(): Promise<void>;
  playing(): boolean;
  publish(status: AutosaveStatus): void;
  root(): Promise<Directory>;
  locks: Pick<LockManager, "request" | "query">;
  now(): number;
  randomId(): string;
}

/**
 * How each kernel call affects the autosave: a newly installed document is
 * written at once, other changes after a short debounce. The exhaustive
 * record makes every new protocol method choose.
 */
const SAVE_TRIGGERS: Record<KernelMethod, "none" | "debounce" | "immediate"> = {
  hello: "none",
  "engine.configure": "none",
  "tone.configure": "none",
  "meters.configure": "none",
  "doc.memory": "none",
  "doc.info": "none",
  "doc.export": "none",
  "doc.readPCM": "none",
  "peaks.get": "none",
  "metadata.get": "none",
  "transport.play": "none",
  "transport.stop": "none",
  "transport.seek": "none",
  "selection.get": "none",
  "selection.snap": "none",
  "timeline.get": "none",
  "timeline.export": "none",
  "edit.state": "none",
  "edit.prepare-paste": "none",
  "history.list": "none",
  "process.start": "none",
  "process.step": "none",
  "process.stepBatch": "none",
  "process.cancel": "none",
  "process.exportCandidate": "none",
  "analysis.start": "none",
  "analysis.step": "none",
  "analysis.cancel": "none",
  "analysis.spectrum": "none",
  "effects.list": "none",
  "effects.response": "none",
  "effects.preview.start": "none",
  "effects.preview.update": "none",
  "effects.preview.stop": "none",
  "effects.preview.meters": "none",
  "effects.ir.load": "none",
  "effects.ir.remove": "none",
  "autosave.delta": "none",
  "recovery.begin": "none",
  "recovery.blocks": "none",
  "recovery.finish": "none",
  "recovery.abort": "none",
  "doc.open": "immediate",
  "doc.openPCM": "immediate",
  "doc.new": "immediate",
  "doc.importBinary": "immediate",
  "metadata.set": "debounce",
  "selection.set": "debounce",
  "markers.add": "debounce",
  "markers.update": "debounce",
  "markers.remove": "debounce",
  "regions.add": "debounce",
  "regions.update": "debounce",
  "regions.remove": "debounce",
  "edit.apply": "debounce",
  "edit.undo": "debounce",
  "edit.redo": "debounce",
  "history.jump": "debounce",
  "doc.mark-saved": "debounce",
  "process.commit": "debounce",
  "analysis.commit": "debounce",
  "effects.apply": "debounce",
};

const LOCK_PREFIX = "aae-autosave:";
/** An edit is on disk within the debounce plus at most this latency's remainder. */
export const DEBOUNCE_MS = 1000;
export const MAX_LATENCY_MS = 2000;
const MiB = 1024 * 1024;

interface Session {
  id: string;
  dir: Directory;
  store: SessionStore;
  release(): void;
}

/** Holds a session's lock until the returned release runs, or the worker dies. */
function hold(locks: AutosaveHost["locks"], id: string): Promise<(() => void) | undefined> {
  return new Promise((resolve, reject) => {
    locks
      .request(LOCK_PREFIX + id, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(undefined);
          return undefined;
        }
        return new Promise<void>((release) => resolve(release));
      })
      .catch(reject);
  });
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The kernel worker's autosave: one session per editor window, owned through
 * a Web Lock that the browser releases when the window or worker dies. A
 * session whose lock is free belongs to a closed or crashed window.
 */
export class WorkerAutosave {
  private readonly host: AutosaveHost;
  private session: Session | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pendingSince: number | undefined;
  private running = false;
  private recovering = false;

  constructor(host: AutosaveHost) {
    this.host = host;
  }

  async enable(): Promise<string> {
    if (this.session) return this.session.id;
    const root = await this.host.root();
    const id = this.host.randomId();
    const release = await hold(this.host.locks, id);
    if (!release) throw new Error("The autosave session is already taken.");
    try {
      const dir = await root.directory(id, true);
      this.session = { id, dir, store: this.createStore(dir), release };
    } catch (error) {
      release();
      throw error;
    }
    this.publish({ state: "idle" });
    this.schedule(0);
    return id;
  }

  /** Called after every successful kernel call. */
  touch(method: KernelMethod) {
    const trigger = SAVE_TRIGGERS[method];
    if (!this.session || this.recovering || trigger === "none") return;
    this.schedule(trigger === "immediate" ? 0 : DEBOUNCE_MS);
  }

  /** Dirty snapshots of closed or crashed windows; clean ones are deleted. */
  async list(closed: string[]): Promise<{ sessions: RecoverableSession[]; removed: string[] }> {
    const root = await this.host.root();
    // List first: a window creates its directory only after taking its lock.
    const names = await root.names();
    const held = new Set(((await this.host.locks.query()).held ?? []).map((lock) => lock.name));
    const sessions: RecoverableSession[] = [];
    const removed: string[] = [];
    for (const id of names) {
      if (id === this.session?.id || held.has(LOCK_PREFIX + id)) continue;
      const release = await hold(this.host.locks, id);
      if (!release) continue;
      try {
        const dir = await root.directory(id, false);
        const manifest = await readManifest(dir).catch(() => undefined);
        if (closed.includes(id) || !manifest?.document.dirty) {
          await root.removeDirectory(id);
          removed.push(id);
          continue;
        }
        const { document } = manifest;
        sessions.push({
          sessionId: id,
          name: document.name,
          sampleRate: document.sampleRate,
          channels: document.channels,
          frames: document.frames,
          savedAt: manifest.savedAt,
          bytes: manifest.segments.reduce((sum, segment) => sum + segment.bytes, 0),
        });
      } finally {
        release();
      }
    }
    sessions.sort((a, b) => b.savedAt - a.savedAt);
    return { sessions, removed };
  }

  /**
   * Restores a session into the kernel and continues it as this window's
   * own; this window's previous session is deleted.
   */
  async recover(
    id: string,
    progress: (done: number, total: number) => void,
  ): Promise<{ info: DocumentInfoResult; sessionId: string }> {
    if (this.recovering) throw new Error("A recovery is already running.");
    const root = await this.host.root();
    const release = await hold(this.host.locks, id);
    if (!release) throw new Error("This autosave is open in another window.");
    this.recovering = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    try {
      while (this.running) await this.host.yieldTask();
      const dir = await root.directory(id, false);
      const { manifest, index } = await readSession(
        dir,
        {
          begin: (nextBlockId) => this.host.call("recovery.begin", { nextBlockId }),
          blocks: (records) => this.host.call("recovery.blocks", undefined, records),
          progress,
        },
        { pause: () => this.host.yieldTask() },
      );
      const info = this.host.call(
        "recovery.finish",
        manifest.document,
        encodeLayout(manifest.layout),
      ) as DocumentInfoResult;
      const store = await SessionStore.adopt(dir, manifest, index, this.storeOptions());
      const previous = this.session;
      this.session = { id, dir, store, release };
      if (previous) {
        previous.store.close();
        await root.removeDirectory(previous.id);
        previous.release();
      }
      return { info, sessionId: id };
    } catch (error) {
      try {
        this.host.call("recovery.abort");
      } catch {
        /* Preserve the recovery error. */
      }
      release();
      throw error;
    } finally {
      this.recovering = false;
      this.schedule(0);
    }
  }

  async discard(id: string) {
    if (id === this.session?.id) throw new Error("This window's own autosave cannot be discarded.");
    const root = await this.host.root();
    const release = await hold(this.host.locks, id);
    if (!release) throw new Error("This autosave is open in another window.");
    try {
      await root.removeDirectory(id);
    } finally {
      release();
    }
  }

  private publish(status: AutosaveStatus) {
    this.host.publish({ ...status, sessionId: this.session?.id });
  }

  private storeOptions() {
    return { now: () => this.host.now(), pause: () => this.host.yieldTask() };
  }

  private createStore(dir: Directory) {
    return new SessionStore(dir, this.storeOptions());
  }

  /** Waits `delay`, but never lets a change wait longer than MAX_LATENCY_MS. */
  private schedule(delay: number) {
    if (!this.session) return;
    const now = this.host.now();
    this.pendingSince ??= now;
    if (this.running || this.recovering) return;
    const wait = Math.max(0, Math.min(delay, this.pendingSince + MAX_LATENCY_MS - now));
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), wait);
  }

  private async run() {
    const session = this.session;
    if (!session || this.running || this.recovering) return;
    this.running = true;
    this.pendingSince = undefined;
    this.timer = undefined;
    try {
      this.publish({ state: "saving" });
      for (;;) {
        const maxBytes = (this.host.playing() ? 8 : 32) * MiB;
        const result = this.host.call("autosave.delta", { maxBytes }) as AutosaveDeltaResult;
        await session.store.apply(result, result.data);
        if (result.complete) {
          this.publish(
            result.document.channels
              ? { state: "saved", savedAt: this.host.now(), dirty: result.document.dirty }
              : { state: "idle" },
          );
          return;
        }
        // Prefill a long document in steps, so edits and playback keep running.
        await this.host.yieldTask();
        if (this.recovering || this.session !== session) return;
      }
    } catch (error) {
      this.publish({ state: "error", error: message(error) });
    } finally {
      this.running = false;
      if (this.pendingSince !== undefined) this.schedule(DEBOUNCE_MS);
    }
  }
}
