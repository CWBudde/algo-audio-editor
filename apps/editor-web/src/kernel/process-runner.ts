import type { ProcessJobParams, ProcessJobResult } from "@aae/protocol";

export interface ProcessRunner {
  step(params: ProcessJobParams): ProcessJobResult;
  yieldTask(): Promise<void>;
  progress(value: ProcessJobResult): void;
}

/** Validate control metadata only; no audio samples leave the Go process job. */
export function validProcessProgress(
  value: unknown,
  params: ProcessJobParams,
  previous?: ProcessJobResult,
): value is ProcessJobResult {
  if (!params.documentId || !params.jobId || !value || typeof value !== "object") return false;
  const p = value as Partial<ProcessJobResult>;
  if (
    p.documentId !== params.documentId ||
    p.jobId !== params.jobId ||
    p.operation !== "gain" ||
    !["running", "ready", "cancelled"].includes(p.state ?? "") ||
    !Number.isFinite(p.gainDb) ||
    !Number.isFinite(p.peak) ||
    (p.peak ?? -1) < 0 ||
    typeof p.nonFinite !== "boolean"
  )
    return false;
  for (const field of ["start", "end", "channelMask", "processedFrames", "totalFrames"] as const) {
    if (!Number.isSafeInteger(p[field]) || (p[field] ?? -1) < 0) return false;
  }
  if (
    (p.end ?? 0) < (p.start ?? 0) ||
    !p.channelMask ||
    p.channelMask > 255 ||
    (p.processedFrames ?? 0) > (p.totalFrames ?? 0)
  )
    return false;
  if (p.state === "ready" && p.processedFrames !== p.totalFrames) return false;
  if (previous) {
    if (
      (p.processedFrames ?? 0) < previous.processedFrames ||
      (p.peak ?? 0) < previous.peak ||
      (previous.nonFinite && !p.nonFinite)
    )
      return false;
    for (const field of ["start", "end", "channelMask", "totalFrames", "gainDb"] as const)
      if (p[field] !== previous[field]) return false;
    if (previous.state !== "running" && p.state !== previous.state) return false;
  }
  return true;
}

/** Each synchronous Go step is bounded; a real task yield lets Cancel run. */
export async function runProcessJob(
  params: ProcessJobParams,
  runner: ProcessRunner,
): Promise<ProcessJobResult> {
  let previous: ProcessJobResult | undefined;
  for (;;) {
    const value = runner.step(params);
    if (!validProcessProgress(value, params, previous))
      throw new Error("process.step returned invalid progress");
    previous = value;
    runner.progress(value);
    if (value.state !== "running") return value;
    await runner.yieldTask();
  }
}
