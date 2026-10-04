import type { PeaksGetResult, ProcessJobResult } from "@aae/protocol";
import type { WorkerReply, WorkerRequest } from "./messages.ts";

export interface ProcessProbeCall {
  method: string;
  startedAt: number;
  endedAt?: number;
  params?: unknown;
  result?: unknown;
}
export interface ProcessProbeOptions {
  methods: readonly string[];
  onProgress?(job: ProcessJobResult): void;
  onReply?(call: ProcessProbeCall): void;
  onError?(error: Error): void;
}
interface ProcessProbe {
  holdCalls(worker: Worker, methods: readonly string[]): () => void;
  observe(
    worker: Worker,
    options: ProcessProbeOptions,
  ): {
    calls: Map<number, ProcessProbeCall>;
    dispose(): void;
  };
  summarizePeaks(peaks: PeaksGetResult): {
    count: number;
    extrema: number[][];
    ranges: number[][];
  };
}
declare global {
  interface Window {
    __aaeProcessProbe?: ProcessProbe;
  }
}

/** Self-contained so Playwright can serialize it with addInitScript. Test-only:
 * all request/reply interpretation lives beside the worker message contract. */
export function installProcessProbe() {
  window.__aaeProcessProbe = {
    holdCalls(worker, methods) {
      const nativePost = worker.postMessage;
      const pending: (() => void)[] = [];
      const post: Worker["postMessage"] = (
        message: unknown,
        transfer?: Transferable[] | StructuredSerializeOptions,
      ) => {
        const request = message as WorkerRequest;
        const send = () =>
          nativePost.call(worker, message, Array.isArray(transfer) ? { transfer } : transfer);
        if (request.op === "call" && methods.includes(request.method)) pending.push(send);
        else send();
      };
      worker.postMessage = post;
      return () => {
        if (worker.postMessage === post) worker.postMessage = nativePost;
        for (const send of pending.splice(0)) send();
      };
    },
    observe(worker, options) {
      const calls = new Map<number, ProcessProbeCall>();
      const nativePost = worker.postMessage;
      const post: Worker["postMessage"] = (
        message: unknown,
        transfer?: Transferable[] | StructuredSerializeOptions,
      ) => {
        const request = message as WorkerRequest;
        const method =
          request.op === "process.run"
            ? "process.run"
            : request.op === "call"
              ? request.method
              : undefined;
        if (method && request.id !== undefined && options.methods.includes(method))
          calls.set(request.id, {
            method,
            startedAt: performance.now(),
            params: request.op === "call" ? request.params : undefined,
          });
        nativePost.call(worker, message, Array.isArray(transfer) ? { transfer } : transfer);
      };
      const onMessage = (event: MessageEvent<WorkerReply>) => {
        const reply = event.data;
        if (reply.kind === "fatal") {
          options.onError?.(new Error(reply.error));
          return;
        }
        const call = calls.get(reply.id);
        if (!call) return;
        if (reply.kind === "process.progress" && call.method === "process.run") {
          options.onProgress?.(reply.progress);
        } else if (reply.kind === "reply") {
          call.endedAt = performance.now();
          if (reply.ok) {
            call.result = reply.result;
            options.onReply?.(call);
          } else options.onError?.(new Error(`${call.method}: ${reply.error}`));
        }
      };
      worker.postMessage = post;
      worker.addEventListener("message", onMessage);
      return {
        calls,
        dispose() {
          if (worker.postMessage === post) worker.postMessage = nativePost;
          worker.removeEventListener("message", onMessage);
        },
      };
    },
    summarizePeaks(peaks) {
      if (
        !(peaks.data instanceof ArrayBuffer) ||
        !Number.isSafeInteger(peaks.count) ||
        peaks.count < 0 ||
        peaks.data.byteLength !== peaks.count * 24
      )
        throw new Error("Invalid packed peak reply");
      const triples = new Float32Array(peaks.data, 0, peaks.count * 3);
      const counts = new Uint32Array(peaks.data, peaks.count * 12, peaks.count);
      const starts = new Float64Array(peaks.data, peaks.count * 16, peaks.count);
      return {
        count: peaks.count,
        extrema: Array.from({ length: peaks.count }, (_, index) => [
          triples[index * 3],
          triples[index * 3 + 1],
        ]),
        ranges: Array.from({ length: peaks.count }, (_, index) => [starts[index], counts[index]]),
      };
    },
  };
}
