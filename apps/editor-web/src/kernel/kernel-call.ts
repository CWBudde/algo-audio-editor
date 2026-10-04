import type {
  ExportInfo,
  KernelBridge,
  KernelMethod,
  KernelResponse,
  PeaksGetInfo,
} from "@aae/protocol";
import type { WorkerResult } from "./messages";
import { decodePeaks } from "./peak-data";

/** Take bulk output synchronously, before another call can replace the bridge slot. */
export function callKernel(
  bridge: KernelBridge,
  method: KernelMethod,
  params: unknown,
  input?: ArrayBuffer,
): WorkerResult {
  const response = JSON.parse(
    bridge.call(
      method,
      params === undefined ? undefined : JSON.stringify(params),
      input === undefined ? undefined : new Uint8Array(input),
    ),
  ) as KernelResponse<unknown>;
  if (!response.ok) throw new Error(response.error);
  const analysis = method === "analysis.start" || method === "analysis.step";
  if (
    (analysis || method === "analysis.spectrum") &&
    !(response.result as { dataBytes?: number }).dataBytes
  )
    return { result: response.result };
  if (
    method !== "peaks.get" &&
    method !== "doc.export" &&
    method !== "doc.readPCM" &&
    method !== "timeline.export" &&
    method !== "process.exportCandidate" &&
    method !== "effects.response" &&
    method !== "analysis.spectrum" &&
    !analysis
  )
    return { result: response.result };

  const bytes = bridge.takeData();
  const info = response.result as PeaksGetInfo | ExportInfo;
  if (bytes.byteLength !== info.dataBytes) {
    throw new Error(`${method}: bulk data length does not match metadata`);
  }
  // Normally the bridge returns a fresh Uint8Array over its complete buffer.
  // A subview needs its own buffer so unrelated bytes cannot cross the boundary.
  const data =
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.slice().buffer;
  if (method === "effects.response") {
    const curve = info as unknown as { count: number; axis: string };
    if (
      !Number.isSafeInteger(curve.count) ||
      curve.count < 2 ||
      curve.count > 8192 ||
      curve.count * 16 !== data.byteLength ||
      !["frequency", "level"].includes(curve.axis)
    )
      throw new Error("effects.response: invalid curve metadata");
    const values = new DataView(data);
    for (let offset = 0; offset < data.byteLength; offset += 8)
      if (!Number.isFinite(values.getFloat64(offset, true)))
        throw new Error("effects.response: nonfinite curve value");
  }
  const result = { ...info, data };
  if (analysis || method === "analysis.spectrum") validateAnalysisData(method, result);
  if (method === "peaks.get") decodePeaks({ ...(info as PeaksGetInfo), data });
  return { result, transfer: [data] };
}

function validateAnalysisData(method: string, result: unknown) {
  const job = result as {
    kind?: string;
    state?: string;
    data: ArrayBuffer;
    channels: number[] | number;
    bins?: number;
    records?: number;
    width?: number;
    height?: number;
  };
  const channels = Array.isArray(job.channels) ? job.channels.length : job.channels;
  if (!Number.isInteger(channels) || channels < 1 || channels > 8)
    throw new Error(`${method}: invalid analysis channels`);
  let length = 0;
  if (job.kind === "spectrogram") {
    if (
      !Number.isInteger(job.width) ||
      !Number.isInteger(job.height) ||
      !job.width ||
      job.width > 128 ||
      !job.height ||
      job.height > 512
    )
      throw new Error(`${method}: invalid tile geometry`);
    length = job.width * job.height * 4;
  } else if (job.kind === "pitch") {
    if (!Number.isSafeInteger(job.records) || (job.records ?? -1) < 0)
      throw new Error(`${method}: invalid pitch records`);
    length = (job.records ?? 0) * 32;
  } else {
    if (!Number.isInteger(job.bins) || !job.bins || job.bins > 4097)
      throw new Error(`${method}: invalid spectrum bins`);
    length = channels * job.bins * 16;
  }
  if (job.data.byteLength !== length) throw new Error(`${method}: invalid analysis data size`);
  if (job.kind !== "spectrogram") {
    const values = new DataView(job.data);
    for (let offset = 0; offset < length; offset += 8) {
      const value = values.getFloat64(offset, true);
      if (Number.isNaN(value) || value === Infinity)
        throw new Error(`${method}: invalid analysis values`);
    }
  }
}
