/// <reference lib="dom" />
import type { BrowserContext, Page } from "@playwright/test";
import { installProcessProbe } from "../src/kernel/process-probe.ts";

declare global {
  interface Window {
    __aaeTest?: {
      workers: Worker[];
      meterBuffer?: SharedArrayBuffer;
      meterConfigurations: unknown[];
      transfers: { before: number; after: number }[];
      openTimings: { bytes: number; startedAt: number; endedAt: number; rpcMs: number }[];
      peakCalls: {
        id: number;
        channel: number;
        startFrame: number;
        endFrame: number;
        buckets: number;
      }[];
      peakReplies: { id: number; count: number; bytes: number; isBuffer: boolean }[];
      request(method: string, params?: unknown): Promise<unknown>;
    };
  }
}

/** Observe production workers without introducing any diagnostic application API. */
export async function captureKernelWorker(page: Page | BrowserContext) {
  await page.addInitScript(installProcessProbe);
  await page.addInitScript(() => {
    // Electron may need both context registration for future extraction windows
    // and explicit registration on its already-created parent page.
    if (window.__aaeTest) return;
    const NativeWorker = window.Worker;
    const workers: Worker[] = [];
    const transfers: { before: number; after: number }[] = [];
    const openTimings: { bytes: number; startedAt: number; endedAt: number; rpcMs: number }[] = [];
    const peakCalls: NonNullable<Window["__aaeTest"]>["peakCalls"] = [];
    const peakReplies: NonNullable<Window["__aaeTest"]>["peakReplies"] = [];
    let nextId = -100;
    window.__aaeTest = {
      workers,
      meterConfigurations: [],
      transfers,
      openTimings,
      peakCalls,
      peakReplies,
      async request(method, params) {
        const createdWorker = workers[0];
        if (!createdWorker) throw new Error("kernel worker missing");
        const worker = createdWorker;
        const id = nextId--;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            worker.removeEventListener("message", onMessage);
            reject(new Error("kernel probe timed out"));
          }, 5_000);
          function onMessage(event: MessageEvent) {
            if (event.data.kind !== "reply" || event.data.id !== id) return;
            clearTimeout(timer);
            worker.removeEventListener("message", onMessage);
            if (event.data.ok) resolve(event.data.result);
            else reject(new Error(event.data.error));
          }
          worker.addEventListener("message", onMessage);
          worker.postMessage({ id, op: "call", method, params });
        });
      },
    };
    window.Worker = class extends NativeWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        if (options?.name === "aae-kernel") workers.push(this);
      }
      override postMessage(
        message: unknown,
        transfer?: Transferable[] | StructuredSerializeOptions,
      ) {
        const request = message as {
          id?: number;
          op?: string;
          buffer?: SharedArrayBuffer;
          method?: string;
          data?: ArrayBuffer;
          params?: { channel: number; startFrame: number; endFrame: number; buckets: number };
        };
        if (request.op === "meters.attach" && window.__aaeTest)
          window.__aaeTest.meterBuffer = request.buffer;
        if (request.method === "meters.configure")
          window.__aaeTest?.meterConfigurations.push(request.params);
        const before = request.data?.byteLength ?? 0;
        const started = performance.now();
        if (request.method === "peaks.get" && request.id !== undefined && request.params) {
          peakCalls.push({ id: request.id, ...request.params });
          const onReply = (event: MessageEvent) => {
            if (event.data.kind !== "reply" || event.data.id !== request.id) return;
            this.removeEventListener("message", onReply);
            if (!event.data.ok) return;
            const result = event.data.result;
            peakReplies.push({
              id: event.data.id,
              count: result.count,
              bytes: result.data?.byteLength ?? 0,
              isBuffer: result.data instanceof ArrayBuffer,
            });
          };
          this.addEventListener("message", onReply);
        }
        if (request.method === "doc.open" && request.data) {
          const onReply = (event: MessageEvent) => {
            if (event.data.kind !== "reply" || event.data.id !== request.id) return;
            this.removeEventListener("message", onReply);
            const endedAt = performance.now();
            openTimings.push({
              bytes: before,
              startedAt: started,
              endedAt,
              rpcMs: endedAt - started,
            });
          };
          this.addEventListener("message", onReply);
        }
        if (Array.isArray(transfer)) super.postMessage(message, transfer);
        else super.postMessage(message, transfer);
        if (request.method === "doc.open" && request.data)
          transfers.push({ before, after: request.data.byteLength });
      }
    };
  });
}
