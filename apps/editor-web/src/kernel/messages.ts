import type {
  AnalysisJobResult,
  AnalysisSpectrumParams,
  KernelMethod,
  ProcessJobResult,
} from "@aae/protocol";
import type { RingBufferInit } from "../audio/ring-buffer.ts";

/**
 * Main thread ↔ kernel worker messages. Every request carries an id and gets
 * exactly one reply with the same id. The worker may also post an unsolicited
 * `fatal` event when the Go program dies.
 */
export type WorkerOp =
  | { op: "init"; wasmUrl: string; wasmExecUrl: string }
  | { op: "call"; method: KernelMethod; params: unknown; data?: ArrayBuffer }
  | { op: "process.run"; documentId: string; jobId: string }
  | { op: "analysis.run"; documentId: string; jobId: string }
  | { op: "spectrum.run"; params: AnalysisSpectrumParams }
  | { op: "spectrum.cancel"; requestId: number }
  | { op: "meters.attach"; buffer?: SharedArrayBuffer }
  | { op: "stream.attach"; ring: RingBufferInit }
  /** Fills the requested preview horizon, or the whole ring for normal playback. */
  | { op: "stream.start"; maxBufferedFrames?: number }
  | { op: "stream.stop" };

export type WorkerRequest = { id: number } & WorkerOp;

/** Worker-local reply plus buffers to move to the main thread without cloning. */
export interface WorkerResult {
  result: unknown;
  transfer?: Transferable[];
}

export type WorkerReply =
  | { kind: "analysis.progress"; id: number; progress: AnalysisJobResult }
  | { kind: "process.progress"; id: number; progress: ProcessJobResult }
  | { kind: "reply"; id: number; ok: true; result: unknown }
  | { kind: "reply"; id: number; ok: false; error: string }
  | { kind: "fatal"; error: string };
