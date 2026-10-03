/// <reference lib="webworker" />
/**
 * Kernel worker: hosts the Go WASM kernel off the main thread and keeps the
 * playback ring buffer filled.
 */
import type { KernelBridge } from "@aae/protocol";
import { FrameRingBuffer } from "@/audio/ring-buffer";
import { callKernel } from "./kernel-call";
import type { WorkerOp, WorkerReply, WorkerRequest, WorkerResult } from "./messages";
import { StreamPump } from "./stream-pump";

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

/** How often the ring is topped up. Must drain far less than the ring holds. */
const PUMP_INTERVAL_MS = 10;

let kernel: KernelBridge | undefined;
let ring: FrameRingBuffer | undefined;
let pumpTimer: ReturnType<typeof setInterval> | undefined;
let streamPump: StreamPump | undefined;

function post(msg: WorkerReply, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
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

/** Renders kernel output into the ring until it is (nearly) full. */
function pump() {
  if (!kernel || !streamPump) return false;
  try {
    streamPump.fill(kernel);
    if (streamPump.ended) stopPump();
    return !streamPump.ended;
  } catch (err) {
    stopPump();
    post({ kind: "fatal", error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

function stopPump() {
  if (pumpTimer !== undefined) {
    clearInterval(pumpTimer);
    pumpTimer = undefined;
  }
}

async function handle(req: WorkerOp): Promise<WorkerResult> {
  switch (req.op) {
    case "init":
      return { result: await boot(req.wasmUrl, req.wasmExecUrl) };
    case "call":
      return callKernel(requireKernel(), req.method, req.params, req.data);
    case "stream.attach":
      stopPump();
      ring = FrameRingBuffer.attach(req.ring);
      streamPump = undefined;
      return { result: undefined };
    case "stream.start":
      if (!ring) throw new Error("stream.start before stream.attach");
      streamPump = new StreamPump(ring);
      if (pump()) pumpTimer ??= setInterval(pump, PUMP_INTERVAL_MS);
      return { result: ring.stats() };
    case "stream.stop":
      stopPump();
      return { result: undefined };
  }
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const { id } = event.data;
  handle(event.data).then(
    ({ result, transfer }) => post({ kind: "reply", id, ok: true, result }, transfer),
    (err: unknown) =>
      post({
        kind: "reply",
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
  );
});
