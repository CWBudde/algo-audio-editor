import type { DesktopBridge } from "@/platform";
import type {
  SpeechCatalog,
  SpeechInitResult,
  SpeechLoaded,
  SpeechOp,
  SpeechProgress,
  SpeechReply,
  SpeechRequest,
  SpeechSynthesisParams,
  SpeechSynthesisResult,
} from "./messages";
import { missingSpeechFiles, resolveSpeechSources, speechFileList } from "./model-source";

/** The subset of Worker the client needs; lets tests substitute a fake. */
export interface SpeechWorkerLike {
  postMessage(message: SpeechRequest, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<SpeechReply>) => void): void;
  terminate(): void;
}

export class SpeechError extends Error {
  override name = "SpeechError";
}

/** The Go program in the speech worker exited, typically out of memory. */
export class SpeechStoppedError extends SpeechError {
  override name = "SpeechStoppedError";
}

/** Progress as the dialog shows it; `read` is the desktop's local copy of a finished download. */
export type SpeechStage =
  | SpeechProgress
  | { stage: "read"; path: string; done: number; total: number };

interface Pending {
  resolve(value: unknown): void;
  reject(reason: Error): void;
  timer?: ReturnType<typeof setTimeout>;
  listener?: (progress: SpeechProgress) => void;
}

function abortError() {
  return new DOMException("Speech generation cancelled", "AbortError");
}

export interface SpeechClientOptions {
  /** Electron's bridge; when it can download speech models the worker reads them from app://. */
  bridge?: DesktopBridge;
  bootTimeoutMs?: number;
}

/** Promise-based RPC client for the speech worker. */
export class SpeechClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly fatalListeners = new Set<(error: string) => void>();
  private fatal: string | undefined;
  private readonly worker: SpeechWorkerLike;
  private readonly bridge: DesktopBridge | undefined;
  private readonly bootTimeoutMs: number;
  private info: SpeechInitResult | undefined;
  private state: SpeechLoaded = { model: "", voices: [] };

  constructor(worker: SpeechWorkerLike, options: SpeechClientOptions = {}) {
    this.worker = worker;
    this.bridge = options.bridge;
    this.bootTimeoutMs = options.bootTimeoutMs ?? 60_000;
    worker.addEventListener("message", (event) => this.onMessage(event.data));
  }

  /** Starts speech.wasm in the worker and reads its catalog. */
  async boot(wasmUrl: string, wasmExecUrl: string): Promise<SpeechCatalog> {
    this.info = (await this.request(
      { op: "init", wasmUrl, wasmExecUrl },
      this.bootTimeoutMs,
    )) as SpeechInitResult;
    return this.info.catalog;
  }

  get catalog(): SpeechCatalog {
    if (!this.info) throw new SpeechError("speech worker not booted");
    return this.info.catalog;
  }

  get sampleRate(): number {
    if (!this.info) throw new SpeechError("speech worker not booted");
    return this.info.sampleRate;
  }

  /** The model and voices the worker holds ready for synthesis. */
  loaded(): SpeechLoaded {
    return { model: this.state.model, voices: [...this.state.voices] };
  }

  get stopped(): boolean {
    return this.fatal !== undefined;
  }

  /**
   * Makes `model` and `voice` ready: downloads what is missing (or lets the
   * desktop main process do it), verifies size and SHA-256 and loads it. A
   * different model replaces the loaded one; loaded files are not fetched again.
   */
  async ensureModel(
    model: string,
    voice: string,
    onProgress?: (progress: SpeechStage) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const files = missingSpeechFiles(this.catalog, model, voice, this.state);
    if (!speechFileList(files).length) return;
    if (signal?.aborted) throw abortError();
    const desktop = Boolean(this.bridge?.ensureSpeechModels);
    const sources = await resolveSpeechSources(files, {
      bridge: this.bridge,
      signal,
      onProgress: (progress) => onProgress?.({ stage: "download", ...progress }),
    });
    if (signal?.aborted) throw abortError();
    // A switch of model drops the old one inside the worker before downloading.
    if (files.weights) this.state = { model: "", voices: [] };
    this.state = (await this.cancellable(
      {
        op: "ensure",
        model,
        voice,
        ...sources,
      },
      signal,
      (progress) =>
        onProgress?.(
          desktop && progress.stage === "download" ? { ...progress, stage: "read" } : progress,
        ),
    )) as SpeechLoaded;
  }

  /** Speaks `params` with the loaded model; resolves with transferred mono float32 PCM. */
  async synthesize(
    params: SpeechSynthesisParams,
    onProgress?: (progress: SpeechStage) => void,
    signal?: AbortSignal,
  ): Promise<SpeechSynthesisResult> {
    const result = (await this.cancellable(
      { op: "synthesize", params },
      signal,
      onProgress,
    )) as SpeechSynthesisResult;
    if (!(result.pcm instanceof ArrayBuffer) || result.pcm.byteLength % 4 !== 0)
      throw new SpeechError("speech worker returned malformed PCM");
    return result;
  }

  /** Aborts the running download and synthesis. */
  cancel(): Promise<void> {
    return this.request({ op: "cancel" }) as Promise<void>;
  }

  async unload(): Promise<void> {
    await this.request({ op: "unload" });
    this.state = { model: "", voices: [] };
  }

  /** Called once if the speech worker dies; also immediately if it already has. */
  onFatal(listener: (error: string) => void): () => void {
    if (this.fatal !== undefined) listener(this.fatal);
    this.fatalListeners.add(listener);
    return () => this.fatalListeners.delete(listener);
  }

  terminate(): void {
    this.worker.terminate();
    this.setFatal("terminated");
    this.failAll(new SpeechStoppedError("speech worker terminated"));
  }

  private async cancellable(
    op: SpeechOp,
    signal: AbortSignal | undefined,
    listener?: (progress: SpeechProgress) => void,
  ): Promise<unknown> {
    if (signal?.aborted) throw abortError();
    const abort = () => void this.cancel().catch(() => {});
    signal?.addEventListener("abort", abort, { once: true });
    try {
      return await this.request(op, undefined, undefined, listener);
    } catch (error) {
      if (signal?.aborted && !(error instanceof SpeechStoppedError)) throw abortError();
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  private request(
    op: SpeechOp,
    timeoutMs?: number,
    transfer?: Transferable[],
    listener?: (progress: SpeechProgress) => void,
  ): Promise<unknown> {
    if (this.fatal !== undefined)
      return Promise.reject(new SpeechStoppedError(`speech worker unavailable: ${this.fatal}`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry: Pending = { resolve, reject, listener };
      if (timeoutMs !== undefined)
        entry.timer = setTimeout(() => {
          this.worker.terminate();
          this.setFatal(`${op.op} timed out after ${timeoutMs} ms`);
          this.failAll(new SpeechStoppedError(`speech ${op.op} timed out after ${timeoutMs} ms`));
        }, timeoutMs);
      this.pending.set(id, entry);
      try {
        this.worker.postMessage({ id, ...op }, transfer);
      } catch (err) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private onMessage(msg: SpeechReply) {
    if (msg.kind === "fatal") {
      this.setFatal(msg.error);
      this.failAll(new SpeechStoppedError(`speech worker stopped: ${msg.error}`));
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    if (msg.kind === "progress") {
      try {
        entry.listener?.(msg.progress);
      } catch {
        /* Observers do not own the RPC lifecycle. */
      }
      return;
    }
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new SpeechError(msg.error));
  }

  private setFatal(error: string) {
    if (this.fatal !== undefined) return;
    this.fatal = error;
    this.state = { model: "", voices: [] };
    for (const listener of this.fatalListeners) {
      try {
        listener(error);
      } catch {
        /* A subscriber must not prevent failing pending RPCs. */
      }
    }
  }

  private failAll(error: Error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
}
