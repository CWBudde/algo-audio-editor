/// <reference lib="dom" />
import type { Page } from "@playwright/test";

declare global {
  interface Window {
    __aaeTest?: {
      workers: Worker[];
      transfers: { before: number; after: number }[];
      openTimings: { bytes: number; rpcMs: number }[];
      request(method: string, params?: unknown): Promise<unknown>;
    };
  }
}

/** Observe production workers without introducing any diagnostic application API. */
export async function captureKernelWorker(page: Page) {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const workers: Worker[] = [];
    const transfers: { before: number; after: number }[] = [];
    const openTimings: { bytes: number; rpcMs: number }[] = [];
    let nextId = -100;
    window.__aaeTest = {
      workers,
      transfers,
      openTimings,
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
        const request = message as { id?: number; method?: string; data?: ArrayBuffer };
        const before = request.data?.byteLength ?? 0;
        const started = performance.now();
        if (request.method === "doc.open" && request.data) {
          const onReply = (event: MessageEvent) => {
            if (event.data.kind !== "reply" || event.data.id !== request.id) return;
            this.removeEventListener("message", onReply);
            openTimings.push({ bytes: before, rpcMs: performance.now() - started });
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
