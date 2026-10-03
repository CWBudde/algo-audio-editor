import type { KernelBridge, ProcessJobParams, ProcessJobResult } from "@aae/protocol";
import { callKernel } from "./kernel-call";

const gainPhases = ["processing"] as const;
const peakPhases = ["analyzing", "processing"] as const;
const loudnessPhases = ["analyzing", "processing", "verifying"] as const;
const operations = [
  "gain",
  "normalize-peak",
  "normalize-loudness",
  "fade-in",
  "fade-out",
  "crossfade",
  "reverse",
  "invert",
  "remove-dc",
  "mono-to-stereo",
  "stereo-to-mono",
  "resample",
  "generate",
  "effects",
  "extract-channel",
];

function finiteNullable(value: unknown): value is number | null {
  return value === null || Number.isFinite(value);
}

export interface ProcessRunner {
  step(params: ProcessJobParams): ProcessJobResult;
  yieldTask(): Promise<void>;
  progress(value: ProcessJobResult): void;
}

/** One bridge crossing for <=4 Go blocks; phase transitions remain observable. */
export function stepProcessBatch(bridge: KernelBridge, params: ProcessJobParams): ProcessJobResult {
  return callKernel(bridge, "process.stepBatch", params).result as ProcessJobResult;
}

/** Validate control metadata only; no audio samples leave the Go process job. */
export function validProcessProgress(
  value: unknown,
  params: ProcessJobParams,
  previous?: ProcessJobResult,
): value is ProcessJobResult {
  if (!params.documentId || !params.jobId || !value || typeof value !== "object") return false;
  const p = value as Partial<ProcessJobResult>;
  const normalize = p.operation === "normalize-peak" || p.operation === "normalize-loudness";
  const legacy = p.operation === "gain" || normalize;
  if (
    p.documentId !== params.documentId ||
    p.jobId !== params.jobId ||
    !operations.includes(p.operation ?? "") ||
    !["running", "ready", "cancelled"].includes(p.state ?? "") ||
    !Number.isFinite(p.gainDb) ||
    !Number.isFinite(p.peak) ||
    (p.peak ?? -1) < 0 ||
    !Number.isFinite(p.inputPeak) ||
    (p.inputPeak ?? -1) < 0 ||
    !finiteNullable(p.inputLufs) ||
    !finiteNullable(p.predictedLufs) ||
    !finiteNullable(p.outputLufs) ||
    typeof p.gainResolved !== "boolean" ||
    typeof p.nonFinite !== "boolean"
  )
    return false;
  for (const field of [
    "start",
    "end",
    "channelMask",
    "processedFrames",
    "totalFrames",
    "planningSteps",
    "phaseIndex",
    "phaseCount",
  ] as const) {
    if (!Number.isSafeInteger(p[field]) || (p[field] ?? -1) < 0) return false;
  }
  if (
    (p.end ?? 0) < (p.start ?? 0) ||
    (legacy && p.end === p.start) ||
    !p.channelMask ||
    p.channelMask > 255 ||
    (p.processedFrames ?? 0) > (p.totalFrames ?? 0) ||
    (legacy && p.totalFrames !== (p.end ?? 0) - (p.start ?? 0))
  )
    return false;
  const phases =
    p.operation === "normalize-loudness"
      ? loudnessPhases
      : p.operation === "normalize-peak" || p.operation === "remove-dc"
        ? peakPhases
        : gainPhases;
  if (
    p.phaseCount !== phases.length ||
    (p.phaseIndex ?? -1) >= phases.length ||
    p.phase !== phases[p.phaseIndex ?? -1]
  )
    return false;
  // Only loudness performs bounded target/measurement finalization. Invented
  // planning counters on a gain or peak job must not extend its watchdog.
  if (p.operation !== "normalize-loudness" && p.planningSteps !== 0) return false;
  if (p.operation === "gain") {
    if (p.target !== undefined || !p.gainResolved || (p.gainDb ?? 0) < -120 || (p.gainDb ?? 0) > 60)
      return false;
  } else if (
    normalize &&
    (!Number.isFinite(p.target) ||
      (p.target ?? 1) > 0 ||
      (p.target ?? -121) < (p.operation === "normalize-peak" ? -120 : -69))
  )
    return false;
  if (!legacy && (p.target !== undefined || !p.gainResolved || p.gainDb !== 0)) return false;
  const candidate = p.candidate;
  if (!candidate) return false;
  if (candidate) {
    for (const field of [
      "sampleRate",
      "channels",
      "frames",
      "start",
      "end",
      "channelMask",
    ] as const)
      if (!Number.isSafeInteger(candidate[field]) || candidate[field] < 0) return false;
    if (
      candidate.sampleRate < 8000 ||
      candidate.sampleRate > 384000 ||
      candidate.channels < 1 ||
      candidate.channels > 8 ||
      candidate.end < candidate.start ||
      candidate.end > candidate.frames ||
      candidate.channelMask < 1 ||
      (candidate.channelMask & (2 ** candidate.channels - 1)) !== candidate.channelMask
    )
      return false;
  }
  if (!p.gainResolved && (p.phaseIndex !== 0 || p.gainDb !== 0 || p.peak !== 0)) return false;
  if (p.phaseIndex !== 0 && !p.gainResolved) return false;
  if (
    p.operation !== "normalize-loudness" &&
    (p.inputLufs !== null || p.predictedLufs !== null || p.outputLufs !== null)
  )
    return false;
  if (p.outputLufs !== null && p.phase !== "verifying") return false;
  if (p.outputLufs !== null && Math.abs((p.outputLufs ?? 0) - (p.target ?? 0)) > 0.01) return false;
  const silent = p.unchangedReason === "silent";
  if (p.unchangedReason !== undefined && !silent) return false;
  if (
    silent &&
    (!normalize ||
      p.state === "running" ||
      !p.gainResolved ||
      p.gainDb !== 0 ||
      p.inputPeak !== 0 ||
      p.peak !== 0 ||
      p.nonFinite ||
      p.inputLufs !== null ||
      p.predictedLufs !== null ||
      p.outputLufs !== null)
  )
    return false;
  if (
    p.operation === "normalize-loudness" &&
    p.gainResolved &&
    !silent &&
    (p.predictedLufs === null || Math.abs((p.predictedLufs ?? 0) - (p.target ?? 0)) > 0.01)
  )
    return false;
  if (
    p.state === "ready" &&
    (p.processedFrames !== p.totalFrames || p.phaseIndex !== p.phaseCount - 1 || !p.gainResolved)
  )
    return false;
  if (previous) {
    if (
      (p.phaseIndex ?? 0) < previous.phaseIndex ||
      (p.phaseIndex === previous.phaseIndex &&
        (p.processedFrames ?? 0) < previous.processedFrames) ||
      (p.peak ?? 0) < previous.peak ||
      (p.inputPeak ?? 0) < previous.inputPeak ||
      (p.planningSteps ?? 0) < previous.planningSteps ||
      (previous.gainResolved &&
        (!p.gainResolved ||
          p.gainDb !== previous.gainDb ||
          (legacy && p.inputPeak !== previous.inputPeak))) ||
      (previous.nonFinite && !p.nonFinite)
    )
      return false;
    if (
      (p.phaseIndex ?? 0) > previous.phaseIndex + 1 &&
      !(silent && p.state === "ready" && p.phaseIndex === p.phaseCount - 1)
    )
      return false;
    for (const field of [
      "start",
      "end",
      "channelMask",
      "totalFrames",
      "operation",
      "target",
      "phaseCount",
    ] as const)
      if (p[field] !== previous[field]) return false;
    for (const field of ["inputLufs", "predictedLufs", "outputLufs"] as const)
      if (previous[field] !== null && p[field] !== previous[field]) return false;
    if (JSON.stringify(candidate) !== JSON.stringify(previous.candidate)) return false;
    if (previous.state !== "running" && p.state !== previous.state) return false;
  }
  return true;
}

/** Each Go batch is bounded; a real task yield lets Cancel run between batches. */
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
