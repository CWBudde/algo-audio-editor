/// <reference lib="webworker" />
/**
 * Kernel worker: hosts the Go WASM kernel off the main thread and keeps the
 * playback ring buffer filled.
 */
import type { KernelBridge, KernelResponse } from "@aae/protocol";
import { FrameRingBuffer } from "@/audio/ring-buffer";
import type { WorkerOp, WorkerReply, WorkerRequest } from "./messages";

declare const self: DedicatedWorkerGlobalScope;

interface GoRuntime {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
}

declare global {
  // Installed by wasm_exec.js and by the Go program respectively.
  var Go: (new () => GoRuntime) | undefined;
  var AAEKernel: KernelBridge | undefined;
  var __aaeKernelReady: (() => void) | undefined;
}

/** Frames rendered per kernel call while topping up the ring. */
const PUMP_BLOCK_FRAMES = 512;
/** How often the ring is topped up. Must drain far less than the ring holds. */
const PUMP_INTERVAL_MS = 10;

let kernel: KernelBridge | undefined;
let ring: FrameRingBuffer | undefined;
let pumpTimer: ReturnType<typeof setInterval> | undefined;
let scratch = new Uint8Array(0);

function post(msg: WorkerReply) {
  self.postMessage(msg);
}

async function boot(wasmUrl: string, wasmExecUrl: string): Promise<unknown> {
  if (kernel) throw new Error("kernel already initialised");

  // wasm_exec.js is a classic script that assigns globalThis.Go; evaluating it
  // as a module works because it has no imports and is already strict.
  await import(/* @vite-ignore */ wasmExecUrl);
  if (!globalThis.Go) throw new Error(`${wasmExecUrl} did not define globalThis.Go`);

  const go = new globalThis.Go();
  const ready = new Promise<void>((resolve) => {
    globalThis.__aaeKernelReady = resolve;
  });

  const response = await fetch(wasmUrl);
  if (!response.ok) {
    throw new Error(`fetch ${wasmUrl}: ${response.status} ${response.statusText}`);
  }
  const { instance } = await WebAssembly.instantiateStreaming(response, go.importObject);

  // run() settles only when the Go program exits, which it never should.
  go.run(instance).then(
    () => post({ kind: "fatal", error: "kernel exited" }),
    (err: unknown) => post({ kind: "fatal", error: `kernel crashed: ${String(err)}` }),
  );
  await ready;

  kernel = globalThis.AAEKernel;
  if (!kernel) throw new Error("kernel did not install globalThis.AAEKernel");
  return undefined;
}

function requireKernel(): KernelBridge {
  if (!kernel) throw new Error("kernel not initialised");
  return kernel;
}

function call(method: string, params: unknown): unknown {
  const json = requireKernel().call(
    method,
    params === undefined ? undefined : JSON.stringify(params),
  );
  const response = JSON.parse(json) as KernelResponse<unknown>;
  if (!response.ok) throw new Error(response.error);
  return response.result;
}

/** Renders kernel output into the ring until it is (nearly) full. */
function pump() {
  if (!kernel || !ring) return;

  const bytesPerBlock = PUMP_BLOCK_FRAMES * ring.channels * Float32Array.BYTES_PER_ELEMENT;
  if (scratch.byteLength !== bytesPerBlock) {
    scratch = new Uint8Array(bytesPerBlock);
  }
  const samples = new Float32Array(scratch.buffer);

  while (ring.availableWrite() >= PUMP_BLOCK_FRAMES) {
    const frames = kernel.render(scratch, PUMP_BLOCK_FRAMES);
    if (frames <= 0) {
      stopPump();
      post({ kind: "fatal", error: `kernel render failed (${frames})` });
      return;
    }
    ring.write(samples, frames);
  }
}

function stopPump() {
  if (pumpTimer !== undefined) {
    clearInterval(pumpTimer);
    pumpTimer = undefined;
  }
}

async function handle(req: WorkerOp): Promise<unknown> {
  switch (req.op) {
    case "init":
      return boot(req.wasmUrl, req.wasmExecUrl);
    case "call":
      return call(req.method, req.params);
    case "stream.attach":
      stopPump();
      ring = FrameRingBuffer.attach(req.ring);
      return undefined;
    case "stream.start":
      if (!ring) throw new Error("stream.start before stream.attach");
      pump();
      pumpTimer ??= setInterval(pump, PUMP_INTERVAL_MS);
      return ring.stats();
    case "stream.stop":
      stopPump();
      return undefined;
  }
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const { id } = event.data;
  handle(event.data).then(
    (result) => post({ kind: "reply", id, ok: true, result }),
    (err: unknown) =>
      post({
        kind: "reply",
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
  );
});
