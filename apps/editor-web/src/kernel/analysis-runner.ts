import type { AnalysisJobParams, AnalysisJobResult } from "@aae/protocol";
import type { WorkerResult } from "./messages";

export function validAnalysisProgress(
  value: unknown,
  params: AnalysisJobParams,
  previous?: AnalysisJobResult,
): value is AnalysisJobResult {
  if (!value || typeof value !== "object") return false;
  const job = value as AnalysisJobResult;
  return (
    job.documentId === params.documentId &&
    job.jobId === params.jobId &&
    ["statistics", "pitch", "spectrum", "spectrogram", "clipping"].includes(job.kind) &&
    ["running", "ready", "cancelled"].includes(job.state) &&
    Number.isSafeInteger(job.start) &&
    Number.isSafeInteger(job.end) &&
    job.start >= 0 &&
    job.end >= job.start &&
    Number.isInteger(job.channelMask) &&
    job.channelMask > 0 &&
    job.channelMask <= 255 &&
    Number.isSafeInteger(job.processedFrames) &&
    job.processedFrames >= 0 &&
    Number.isSafeInteger(job.totalFrames) &&
    job.totalFrames >= job.processedFrames &&
    Number.isInteger(job.sampleRate) &&
    job.sampleRate >= 8000 &&
    job.sampleRate <= 384000 &&
    Array.isArray(job.channels) &&
    job.channels.length > 0 &&
    job.channels.length <= 8 &&
    job.channels.every((channel) => Number.isInteger(channel) && channel >= 0 && channel < 8) &&
    Number.isSafeInteger(job.dataBytes) &&
    job.dataBytes >= 0 &&
    (job.dataBytes === 0 ||
      (job.data instanceof ArrayBuffer && job.data.byteLength === job.dataBytes)) &&
    (job.state !== "running" || job.dataBytes === 0 || job.kind === "spectrogram") &&
    (!previous ||
      (job.kind === previous.kind &&
        job.totalFrames === previous.totalFrames &&
        job.processedFrames >= previous.processedFrames &&
        (job.completedColumns ?? 0) >= (previous.completedColumns ?? 0)))
  );
}

export async function runAnalysisJob(
  params: AnalysisJobParams,
  options: {
    step(includeData: boolean): WorkerResult;
    progress(job: AnalysisJobResult, transfer?: Transferable[]): void;
    yieldTask(): Promise<void>;
  },
): Promise<WorkerResult> {
  let previous: AnalysisJobResult | undefined;
  let published = -Infinity;
  for (;;) {
    const now = performance.now();
    const result = options.step(now - published >= 50);
    if (!validAnalysisProgress(result.result, params, previous))
      throw new Error("Invalid analysis progress");
    const job = result.result;
    previous = job;
    if (job.state !== "running") return result;
    if (now - published >= 50) {
      options.progress(job, result.transfer);
      published = now;
    }
    await options.yieldTask();
  }
}
