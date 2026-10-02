/**
 * Kernel ABI: method names, request params and results.
 *
 * Mirrors packages/kernel/internal/protocol/protocol.go by hand. Change both
 * sides in the same commit, and bump PROTOCOL_VERSION when an existing payload
 * changes shape.
 */

/** Must equal protocol.Version in the Go kernel. */
export const PROTOCOL_VERSION = 1;

/** Envelope returned by every `AAEKernel.call`. */
export type KernelResponse<T> = { ok: true; result: T } | { ok: false; error: string };

export interface HelloResult {
  protocolVersion: number;
  kernelVersion: string;
  buildTime: string;
  goVersion: string;
  sampleRate: number;
  channels: number;
}

export interface EngineConfigureParams {
  sampleRate: number;
  channels: number;
}

export interface EngineConfigureResult {
  sampleRate: number;
  channels: number;
}

export interface ToneConfigureParams {
  frequencyHz: number;
  amplitude: number;
}

/** `frequencyHz` comes back rounded to whole hertz. */
export interface ToneConfigureResult {
  frequencyHz: number;
  amplitude: number;
}

/** Every kernel method with its params and result types. */
export interface KernelMethods {
  hello: { params: undefined; result: HelloResult };
  "engine.configure": { params: EngineConfigureParams; result: EngineConfigureResult };
  "tone.configure": { params: ToneConfigureParams; result: ToneConfigureResult };
}

export type KernelMethod = keyof KernelMethods;
export type ParamsOf<M extends KernelMethod> = KernelMethods[M]["params"];
export type ResultOf<M extends KernelMethod> = KernelMethods[M]["result"];

/** The object the Go program installs as `globalThis.AAEKernel`. */
export interface KernelBridge {
  /** Returns a JSON-encoded {@link KernelResponse}. */
  call(method: string, paramsJSON?: string): string;
  /**
   * Renders `frames` interleaved float32 frames into `dst` (little-endian
   * bytes) and returns the number written, or -1 on invalid arguments.
   */
  render(dst: Uint8Array, frames: number): number;
}
