import type {
  AnalysisJobParams,
  AnalysisSpectrumParams,
  AnalysisSpectrumResult,
} from "@aae/protocol";
import type { WorkerResult } from "./messages";
export function validLiveSpectrum(value: unknown): value is AnalysisSpectrumResult {
  if (!value || typeof value !== "object") return false;
  const result = value as AnalysisSpectrumResult;
  return (
    typeof result.documentId === "string" &&
    !!result.documentId &&
    typeof result.jobId === "string" &&
    !!result.jobId &&
    result.source === "playback" &&
    Number.isInteger(result.sampleRate) &&
    result.sampleRate >= 8000 &&
    result.sampleRate <= 384000 &&
    Number.isInteger(result.channels) &&
    result.channels >= 1 &&
    result.channels <= 8 &&
    Number.isInteger(result.fftSize) &&
    result.fftSize >= 256 &&
    result.fftSize <= 8192 &&
    (result.fftSize & (result.fftSize - 1)) === 0 &&
    result.bins === result.fftSize / 2 + 1 &&
    (result.state === "running"
      ? result.dataBytes === 0
      : result.state === "ready" &&
        result.dataBytes === result.channels * result.bins * 16 &&
        result.data instanceof ArrayBuffer &&
        result.data.byteLength === result.dataBytes)
  );
}
export async function runLiveSpectrum(
  params: AnalysisSpectrumParams,
  options: {
    step(params: AnalysisSpectrumParams): WorkerResult;
    cancel(params: AnalysisJobParams): void;
    yieldTask(): Promise<void>;
    cancelled(): boolean;
  },
): Promise<WorkerResult> {
  let identity: AnalysisJobParams | undefined;
  try {
    for (;;) {
      if (options.cancelled()) throw new Error("Spectrum cancelled");
      const result = options.step({ ...params, ...(identity ? { jobId: identity.jobId } : {}) }),
        value = result.result as AnalysisSpectrumResult;
      if (
        !identity &&
        value &&
        typeof value.documentId === "string" &&
        value.documentId &&
        typeof value.jobId === "string" &&
        value.jobId
      )
        identity = { documentId: value.documentId, jobId: value.jobId };
      if (
        !validLiveSpectrum(value) ||
        (identity && (value.jobId !== identity.jobId || value.documentId !== identity.documentId))
      )
        throw new Error("Invalid live spectrum identity");
      identity = { jobId: value.jobId, documentId: value.documentId };
      if (value.state === "ready") return result;
      await options.yieldTask();
    }
  } finally {
    if (identity) options.cancel(identity);
  }
}
