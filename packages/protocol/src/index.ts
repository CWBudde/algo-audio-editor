/**
 * Kernel ABI: method names, request params and results.
 *
 * Mirrors packages/kernel/internal/protocol/protocol.go by hand. Change both
 * sides in the same commit, and bump PROTOCOL_VERSION when an existing payload
 * changes shape.
 */

/** Must equal protocol.Version in the Go kernel. */
export const PROTOCOL_VERSION = 3;

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

/** Retained samples and peaks; excludes metadata, block lists and runtime overhead. */
export interface DocumentMemoryResult {
  sampleBytes: number;
  peakBytes: number;
  uniqueBlocks: number;
  blockReferences: number;
}

/** Viewport and desired pixel width; output count can exceed buckets. */
export interface PeaksGetParams {
  channel: number;
  startFrame: number;
  endFrame: number;
  buckets: number;
}

export interface PeaksGetInfo {
  framesPerBucket: number;
  count: number;
  dataBytes: number;
}

/**
 * Buffer layout (little-endian): count min/max/RMS float32 triples,
 * count uint32 frame counts, then count float64 absolute start frames.
 * Cached records can straddle the viewport; draw at their true positions.
 */
export interface PeaksGetResult extends PeaksGetInfo {
  data: ArrayBuffer;
}

/** File contents accompany the control payload as transferable bytes. */
export interface DocumentOpenParams {
  name: string;
}

export interface DocumentInfoResult {
  name: string;
  sampleRate: number;
  channels: number;
  frames: number;
  bitDepth: number;
  float: boolean;
}

export interface DocumentExportParams {
  format: "wav";
  bitDepth: number;
  float: boolean;
}

export interface ExportInfo {
  name: string;
  mimeType: string;
  dataBytes: number;
}

export interface ExportResult extends ExportInfo {
  data: ArrayBuffer;
}

/** Every kernel method with its params and result types. */
export interface KernelMethods {
  hello: { params: undefined; result: HelloResult };
  "engine.configure": { params: EngineConfigureParams; result: EngineConfigureResult };
  "tone.configure": { params: ToneConfigureParams; result: ToneConfigureResult };
  "doc.memory": { params: undefined; result: DocumentMemoryResult };
  "peaks.get": { params: PeaksGetParams; result: PeaksGetResult };
  "doc.open": { params: DocumentOpenParams; result: DocumentInfoResult };
  "doc.info": { params: undefined; result: DocumentInfoResult };
  "doc.export": { params: DocumentExportParams; result: ExportResult };
}

export type KernelMethod = keyof KernelMethods;
export type ParamsOf<M extends KernelMethod> = KernelMethods[M]["params"];
export type ResultOf<M extends KernelMethod> = KernelMethods[M]["result"];

/** The object the Go program installs as `globalThis.AAEKernel`. */
export interface KernelBridge {
  /** Returns a JSON-encoded {@link KernelResponse}. */
  call(method: string, paramsJSON?: string, data?: Uint8Array): string;
  /** Takes the binary result of the preceding call; returns empty data otherwise. */
  takeData(): Uint8Array;
  /**
   * Renders `frames` interleaved float32 frames into `dst` (little-endian
   * bytes) and returns the number written, or -1 on invalid arguments.
   */
  render(dst: Uint8Array, frames: number): number;
}
