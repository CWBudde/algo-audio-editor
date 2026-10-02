import {
  type HelloResult,
  type KernelMethod,
  type ParamsOf,
  PROTOCOL_VERSION,
  type ResultOf,
} from "@aae/protocol";
import type { RingBufferInit, RingBufferStats } from "@/audio/ring-buffer";
import type { WorkerOp, WorkerReply, WorkerRequest } from "./messages";

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
}

type CallArgs<M extends KernelMethod> = ParamsOf<M> extends undefined ? [] : [ParamsOf<M>];

export interface KernelClientOptions {
  /** Per-request timeout. Booting downloads the WASM, so it gets longer. */
  timeoutMs?: number;
  bootTimeoutMs?: number;
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

  constructor(worker: WorkerLike, options: KernelClientOptions = {}) {
    this.worker = worker;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.bootTimeoutMs = options.bootTimeoutMs ?? 30_000;
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
    return this.request({ op: "call", method, params: params[0] }) as Promise<ResultOf<M>>;
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
    this.fatal ??= "terminated";
    this.failAll(new KernelError("kernel terminated"));
  }

  private request(op: WorkerOp, timeoutMs = this.timeoutMs): Promise<unknown> {
    if (this.fatal !== undefined) {
      return Promise.reject(new KernelError(`kernel unavailable: ${this.fatal}`));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new KernelTimeoutError(`${describe(op)} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, ...op });
    });
  }

  private onMessage(msg: WorkerReply) {
    if (msg.kind === "fatal") {
      this.fatal = msg.error;
      this.failAll(new KernelError(`kernel unavailable: ${msg.error}`));
      for (const listener of this.fatalListeners) listener(msg.error);
      return;
    }

    const entry = this.pending.get(msg.id);
    if (!entry) return; // already timed out
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new KernelError(msg.error));
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
