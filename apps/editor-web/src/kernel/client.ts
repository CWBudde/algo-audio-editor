import {
  type DocumentInfoResult,
  type HelloResult,
  type KernelMethod,
  type ParamsOf,
  PROTOCOL_VERSION,
  type ProcessJobParams,
  type ProcessJobResult,
  type ResultOf,
} from "@aae/protocol";
import type { RingBufferInit, RingBufferStats } from "@/audio/ring-buffer";
import type { WorkerOp, WorkerReply, WorkerRequest } from "./messages";
import { validProcessProgress } from "./process-runner";

/** The subset of Worker the client needs; lets tests substitute a fake. */
export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerReply>) => void): void;
  terminate(): void;
}

/** The kernel rejected a call; `message` is the kernel's own error text. */
export class KernelError extends Error {
  override name = "KernelError";
}

export class KernelTimeoutError extends Error {
  override name = "KernelTimeoutError";
}

interface Pending {
  resolve(value: unknown): void;
  reject(reason: Error): void;
  timer: ReturnType<typeof setTimeout>;
  process?: {
    params: ProcessJobParams;
    progress?: ProcessJobResult;
    listener?: (progress: ProcessJobResult) => void;
  };
}

type CallArgs<M extends KernelMethod> = ParamsOf<M> extends undefined ? [] : [ParamsOf<M>];

export interface KernelClientOptions {
  /** Per-request timeout. Booting downloads the WASM, so it gets longer. */
  timeoutMs?: number;
  bootTimeoutMs?: number;
  processTimeoutMs?: number;
}

/** Promise-based RPC client for the kernel worker. */
export class KernelClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly fatalListeners = new Set<(error: string) => void>();
  private fatal: string | undefined;
  private readonly worker: WorkerLike;
  private readonly timeoutMs: number;
  private readonly bootTimeoutMs: number;
  private readonly processTimeoutMs: number;

  constructor(worker: WorkerLike, options: KernelClientOptions = {}) {
    this.worker = worker;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.bootTimeoutMs = options.bootTimeoutMs ?? 30_000;
    this.processTimeoutMs = options.processTimeoutMs ?? 15_000;
    worker.addEventListener("message", (event) => this.onMessage(event.data));
  }

  /**
   * Boots the kernel in `worker` and verifies the ABI version. Rejects if the
   * kernel speaks a different protocol than this build of the frontend.
   */
  async boot(wasmUrl: string, wasmExecUrl: string): Promise<HelloResult> {
    await this.request({ op: "init", wasmUrl, wasmExecUrl }, this.bootTimeoutMs);
    const hello = await this.call("hello");
    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      throw new KernelError(
        `kernel speaks protocol v${hello.protocolVersion}, frontend expects v${PROTOCOL_VERSION}`,
      );
    }
    return hello;
  }

  call<M extends KernelMethod>(method: M, ...params: CallArgs<M>): Promise<ResultOf<M>> {
    return this.request(
      { op: "call", method, params: params[0] },
      method === "doc.export" ? 60_000 : this.timeoutMs,
    ) as Promise<ResultOf<M>>;
  }

  /** Ownership of bytes moves to the worker; the caller's buffer is detached. */
  openDocument(name: string, bytes: ArrayBuffer): Promise<DocumentInfoResult> {
    return this.request({ op: "call", method: "doc.open", params: { name }, data: bytes }, 60_000, [
      bytes,
    ]) as Promise<DocumentInfoResult>;
  }

  /** One final reply; matching progress extends the inactivity watchdog. */
  runProcess(
    params: ProcessJobParams,
    onProgress?: (progress: ProcessJobResult) => void,
  ): Promise<ProcessJobResult> {
    return this.request({ op: "process.run", ...params }, this.processTimeoutMs, undefined, {
      params: { ...params },
      listener: onProgress,
    }) as Promise<ProcessJobResult>;
  }

  attachStream(ring: RingBufferInit): Promise<void> {
    return this.request({ op: "stream.attach", ring }) as Promise<void>;
  }

  /** Resolves once the ring has been filled, so playback can start glitch-free. */
  startStream(): Promise<RingBufferStats> {
    return this.request({ op: "stream.start" }) as Promise<RingBufferStats>;
  }

  stopStream(): Promise<void> {
    return this.request({ op: "stream.stop" }) as Promise<void>;
  }

  /** Called once if the kernel dies; also immediately if it already has. */
  onFatal(listener: (error: string) => void): () => void {
    if (this.fatal !== undefined) listener(this.fatal);
    this.fatalListeners.add(listener);
    return () => this.fatalListeners.delete(listener);
  }

  terminate(): void {
    this.worker.terminate();
    this.setFatal("terminated");
    this.failAll(new KernelError("kernel terminated"));
  }

  private request(
    op: WorkerOp,
    timeoutMs = this.timeoutMs,
    transfer?: Transferable[],
    process?: Pending["process"],
  ): Promise<unknown> {
    if (this.fatal !== undefined) {
      return Promise.reject(new KernelError(`kernel unavailable: ${this.fatal}`));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (process || (op.op === "call" && op.method.startsWith("process."))) {
          this.fatalTimeout(
            id,
            process
              ? `process.run inactive for ${timeoutMs} ms`
              : `${describe(op)} timed out after ${timeoutMs} ms`,
          );
          return;
        }
        this.pending.delete(id);
        reject(new KernelTimeoutError(`${describe(op)} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, process });
      try {
        this.worker.postMessage({ id, ...op }, transfer);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private onMessage(msg: WorkerReply) {
    if (msg.kind === "fatal") {
      this.setFatal(msg.error);
      this.failAll(new KernelError(`kernel unavailable: ${msg.error}`));
      return;
    }

    const entry = this.pending.get(msg.id);
    if (!entry) return; // already timed out
    if (msg.kind === "process.progress") {
      const process = entry.process;
      if (!process || !validProcessProgress(msg.progress, process.params, process.progress)) return;
      const previous = process.progress;
      if (
        previous &&
        previous.state === msg.progress.state &&
        previous.phaseIndex === msg.progress.phaseIndex &&
        previous.processedFrames === msg.progress.processedFrames &&
        previous.planningSteps === msg.progress.planningSteps &&
        previous.gainResolved === msg.progress.gainResolved &&
        previous.gainDb === msg.progress.gainDb &&
        previous.inputPeak === msg.progress.inputPeak &&
        previous.inputLufs === msg.progress.inputLufs &&
        previous.predictedLufs === msg.progress.predictedLufs &&
        previous.outputLufs === msg.progress.outputLufs &&
        previous.peak === msg.progress.peak &&
        previous.nonFinite === msg.progress.nonFinite
      )
        return;
      process.progress = { ...msg.progress };
      clearTimeout(entry.timer);
      entry.timer = setTimeout(
        () => this.fatalTimeout(msg.id, `process.run inactive for ${this.processTimeoutMs} ms`),
        this.processTimeoutMs,
      );
      try {
        process.listener?.(msg.progress);
      } catch {
        /* Observers must not break the RPC lifecycle. */
      }
      return;
    }
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (
      msg.ok &&
      entry.process &&
      (!validProcessProgress(msg.result, entry.process.params, entry.process.progress) ||
        msg.result.state === "running")
    ) {
      entry.reject(new KernelError("process.run returned invalid terminal progress"));
      return;
    }
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new KernelError(msg.error));
  }

  private fatalTimeout(id: number, message: string) {
    const entry = this.pending.get(id);
    if (!entry) return;
    // Kill computation and notify owners before the promise releases their lock.
    this.worker.terminate();
    this.setFatal(message);
    this.failAll(new KernelTimeoutError(message));
  }

  private setFatal(error: string) {
    if (this.fatal !== undefined) return;
    this.fatal = error;
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

function describe(op: WorkerOp): string {
  return op.op === "call" ? `call ${op.method}` : op.op;
}
