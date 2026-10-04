import {
  type AnalysisJobParams,
  type AnalysisJobResult,
  type AnalysisSpectrumParams,
  type AnalysisSpectrumResult,
  type BinaryDocumentParams,
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
import { validAnalysisProgress } from "./analysis-runner";
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
  analysis?: {
    listener?: (progress: AnalysisJobResult) => void;
    documentId: string;
    jobId: string;
    progress?: AnalysisJobResult;
  };
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
  analysisTimeoutMs?: number;
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
  private readonly analysisTimeoutMs: number;

  constructor(worker: WorkerLike, options: KernelClientOptions = {}) {
    this.worker = worker;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.bootTimeoutMs = options.bootTimeoutMs ?? 30_000;
    this.processTimeoutMs = options.processTimeoutMs ?? 15_000;
    this.analysisTimeoutMs = options.analysisTimeoutMs ?? 60_000;
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

  /** Exact float32 samples move to this window's kernel without codec conversion. */
  openPCMDocument(params: BinaryDocumentParams, bytes: ArrayBuffer): Promise<DocumentInfoResult> {
    return this.request({ op: "call", method: "doc.openPCM", params, data: bytes }, 60_000, [
      bytes,
    ]) as Promise<DocumentInfoResult>;
  }

  importBinaryDocument(
    params: BinaryDocumentParams,
    bytes: ArrayBuffer,
  ): Promise<DocumentInfoResult> {
    return this.request({ op: "call", method: "doc.importBinary", params, data: bytes }, 60_000, [
      bytes,
    ]) as Promise<DocumentInfoResult>;
  }

  loadImpulseResponse(
    documentId: string,
    name: string,
    data: ArrayBuffer,
  ): Promise<import("@aae/protocol").EffectIRResult> {
    return this.request(
      { op: "call", method: "effects.ir.load", params: { documentId, name }, data },
      60_000,
      [data],
    ) as Promise<import("@aae/protocol").EffectIRResult>;
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
  startStream(maxBufferedFrames?: number): Promise<RingBufferStats> {
    return this.request({
      op: "stream.start",
      ...(maxBufferedFrames === undefined ? {} : { maxBufferedFrames }),
    }) as Promise<RingBufferStats>;
  }

  stopStream(): Promise<void> {
    return this.request({ op: "stream.stop" }) as Promise<void>;
  }

  attachMeters(buffer?: SharedArrayBuffer): Promise<void> {
    return this.request({ op: "meters.attach", buffer }) as Promise<void>;
  }

  /** Bounded worker steps yield to playback; abort discards only this job. */
  runAnalysis(
    params: AnalysisJobParams,
    onProgress?: (progress: AnalysisJobResult) => void,
    signal?: AbortSignal,
  ): Promise<AnalysisJobResult> {
    const abort = () => {
      void this.call("analysis.cancel", params).catch(() => {});
    };
    if (signal?.aborted) {
      abort();
      return Promise.reject(new DOMException("Analysis cancelled", "AbortError"));
    }
    signal?.addEventListener("abort", abort, { once: true });
    return (
      this.request(
        { op: "analysis.run", ...params },
        this.analysisTimeoutMs,
        undefined,
        undefined,
        { ...params, listener: onProgress },
      ) as Promise<AnalysisJobResult>
    ).finally(() => signal?.removeEventListener("abort", abort));
  }

  /** A bounded live snapshot has its own job, independent of offline tiles. */
  runSpectrum(
    params: AnalysisSpectrumParams,
    signal?: AbortSignal,
  ): Promise<AnalysisSpectrumResult> {
    if (signal?.aborted)
      return Promise.reject(new DOMException("Spectrum cancelled", "AbortError"));
    const requestId = this.nextId;
    const abort = () => {
      void this.request({ op: "spectrum.cancel", requestId }).catch(() => {});
    };
    signal?.addEventListener("abort", abort, { once: true });
    return (
      this.request(
        { op: "spectrum.run", params },
        this.analysisTimeoutMs,
      ) as Promise<AnalysisSpectrumResult>
    ).finally(() => signal?.removeEventListener("abort", abort));
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
    analysis?: Pending["analysis"],
  ): Promise<unknown> {
    if (this.fatal !== undefined) {
      return Promise.reject(new KernelError(`kernel unavailable: ${this.fatal}`));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (op.op === "spectrum.run")
          void this.request({ op: "spectrum.cancel", requestId: id }).catch(() => {});
        if (analysis)
          void this.call("analysis.cancel", {
            documentId: analysis.documentId,
            jobId: analysis.jobId,
          }).catch(() => {});
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
      this.pending.set(id, { resolve, reject, timer, process, analysis });
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
    if (msg.kind === "analysis.progress") {
      const analysis = entry.analysis;
      if (!analysis || !validAnalysisProgress(msg.progress, analysis, analysis.progress)) return;
      analysis.progress = msg.progress;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        this.pending.delete(msg.id);
        void this.call("analysis.cancel", {
          documentId: analysis.documentId,
          jobId: analysis.jobId,
        }).catch(() => {});
        entry.reject(
          new KernelTimeoutError(`analysis.run inactive for ${this.analysisTimeoutMs} ms`),
        );
      }, this.analysisTimeoutMs);
      try {
        analysis.listener?.(msg.progress);
      } catch {
        /* Observers do not own the RPC lifecycle. */
      }
      return;
    }
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
      entry.analysis &&
      (!validAnalysisProgress(msg.result, entry.analysis, entry.analysis.progress) ||
        msg.result.state === "running")
    ) {
      void this.call("analysis.cancel", {
        documentId: entry.analysis.documentId,
        jobId: entry.analysis.jobId,
      }).catch(() => {});
      entry.reject(new KernelError("analysis.run returned invalid terminal progress"));
      return;
    }
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
