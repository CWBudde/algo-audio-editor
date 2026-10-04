/// <reference lib="webworker" />
/**
 * Kernel worker: hosts the Go WASM kernel off the main thread and keeps the
 * playback ring buffer filled.
 */
import type { KernelBridge } from "@aae/protocol";
import { MeterPublisher } from "@/audio/meter-data";
import { FrameRingBuffer } from "@/audio/ring-buffer";
import { runAnalysisJob } from "./analysis-runner";
import { callKernel } from "./kernel-call";
import { runLiveSpectrum } from "./live-spectrum-runner";
import type { WorkerReply, WorkerRequest, WorkerResult } from "./messages";
import { runProcessJob, stepProcessBatch } from "./process-runner";
import { StreamPump, withStreamRefill } from "./stream-pump";
import { createTaskYield } from "./task-yield";

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

let kernel: KernelBridge | undefined;
let ring: FrameRingBuffer | undefined;
let pumpTimer: ReturnType<typeof setInterval> | undefined;
let streamPump: StreamPump | undefined;
let processRunning = false;
let meterPublisher: MeterPublisher | undefined;
const analyses = new Set<string>();
const spectra = new Set<number>();
const taskYield = createTaskYield();

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
    meterPublisher?.publish((target) => kernel?.copyMeters(target) ?? 0);
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

async function spectrum(
  id: number,
  params: import("@aae/protocol").AnalysisSpectrumParams,
): Promise<WorkerResult> {
  spectra.add(id);
  try {
    return await runLiveSpectrum(params, {
      step: (params) =>
        withStreamRefill("analysis.spectrum", pumpTimer === undefined ? undefined : pump, () =>
          callKernel(requireKernel(), "analysis.spectrum", params),
        ),
      cancel: (params) => {
        try {
          withStreamRefill("analysis.cancel", pumpTimer === undefined ? undefined : pump, () =>
            callKernel(requireKernel(), "analysis.cancel", params),
          );
        } catch {
          /* Preserve cancellation or snapshot error. */
        }
      },
      yieldTask: taskYield.yieldTask,
      cancelled: () => !spectra.has(id),
    });
  } finally {
    spectra.delete(id);
  }
}

async function handle(req: WorkerRequest): Promise<WorkerResult> {
  switch (req.op) {
    case "init":
      return { result: await boot(req.wasmUrl, req.wasmExecUrl) };
    case "call": {
      if (req.method === "analysis.spectrum")
        return spectrum(req.id, req.params as import("@aae/protocol").AnalysisSpectrumParams);
      const result = withStreamRefill(req.method, pumpTimer === undefined ? undefined : pump, () =>
        callKernel(requireKernel(), req.method, req.params, req.data),
      );
      meterPublisher?.publish((target) => requireKernel().copyMeters(target));
      return result;
    }
    case "spectrum.run":
      return spectrum(req.id, req.params);
    case "spectrum.cancel":
      spectra.delete(req.requestId);
      return { result: undefined };
    case "meters.attach":
      meterPublisher = req.buffer ? new MeterPublisher(req.buffer) : undefined;
      meterPublisher?.publish((target) => requireKernel().copyMeters(target));
      return { result: undefined };
    case "analysis.run": {
      if (analyses.has(req.jobId)) throw new Error("Analysis runner already active");
      const bridge = requireKernel();
      const params = { documentId: req.documentId, jobId: req.jobId };
      analyses.add(req.jobId);
      try {
        return await runAnalysisJob(params, {
          step: (includeData) =>
            withStreamRefill("analysis.step", pumpTimer === undefined ? undefined : pump, () =>
              callKernel(bridge, "analysis.step", { ...params, includeData }),
            ),
          progress: (progress, transfer) =>
            post({ kind: "analysis.progress", id: req.id, progress }, transfer),
          yieldTask: taskYield.yieldTask,
        });
      } catch (error) {
        try {
          callKernel(bridge, "analysis.cancel", params);
        } catch {
          /* Preserve the driver error. */
        }
        throw error;
      } finally {
        analyses.delete(req.jobId);
      }
    }
    case "process.run": {
      if (processRunning) throw new Error("another processing runner is active");
      const bridge = requireKernel();
      const params = { documentId: req.documentId, jobId: req.jobId };
      processRunning = true;
      try {
        const result = await runProcessJob(params, {
          step: (target) => stepProcessBatch(bridge, target),
          yieldTask: taskYield.yieldTask,
          progress: (progress) => post({ kind: "process.progress", id: req.id, progress }),
        });
        return { result };
      } catch (error) {
        // Discard scratch on driver failure; this path never commits the job.
        try {
          callKernel(bridge, "process.cancel", params);
        } catch {
          /* Preserve the original error. */
        }
        throw error;
      } finally {
        processRunning = false;
      }
    }
    case "stream.attach":
      stopPump();
      ring = FrameRingBuffer.attach(req.ring);
      streamPump = undefined;
      return { result: undefined };
    case "stream.start":
      if (!ring) throw new Error("stream.start before stream.attach");
      stopPump();
      streamPump = new StreamPump(ring, req.maxBufferedFrames);
      if (pump()) pumpTimer = setInterval(pump, streamPump.intervalMs);
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
