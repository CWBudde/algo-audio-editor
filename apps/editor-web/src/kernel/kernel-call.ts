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
  if (method !== "peaks.get" && method !== "doc.export") return { result: response.result };

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
  const result = { ...info, data };
  if (method === "peaks.get") decodePeaks({ ...(info as PeaksGetInfo), data });
  return { result, transfer: [data] };
}
