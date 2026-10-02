import type { KernelMethod } from "@aae/protocol";
import type { RingBufferInit } from "@/audio/ring-buffer";

/**
 * Main thread ↔ kernel worker messages. Every request carries an id and gets
 * exactly one reply with the same id. The worker may also post an unsolicited
 * `fatal` event when the Go program dies.
 */
export type WorkerOp =
  | { op: "init"; wasmUrl: string; wasmExecUrl: string }
  | { op: "call"; method: KernelMethod; params: unknown }
  | { op: "stream.attach"; ring: RingBufferInit }
  /** Fills the ring completely, then replies and keeps it topped up. */
  | { op: "stream.start" }
  | { op: "stream.stop" };

export type WorkerRequest = { id: number } & WorkerOp;

/** Worker-local reply plus buffers to move to the main thread without cloning. */
export interface WorkerResult {
  result: unknown;
  transfer?: Transferable[];
}

export type WorkerReply =
  | { kind: "reply"; id: number; ok: true; result: unknown }
  | { kind: "reply"; id: number; ok: false; error: string }
  | { kind: "fatal"; error: string };
