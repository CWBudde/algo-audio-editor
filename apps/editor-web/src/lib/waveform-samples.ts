import type { FrameRange } from "./waveform-geometry";

export type SampleDisplayMode = "linear" | "steps";

export const MAX_SAMPLE_PAGE_FRAMES = 8192;
export const MAX_SAMPLE_VIEW_FRAMES = 1 << 20;

/** Exact-sample detail uses CSS spacing, not backing-bitmap/DPR resolution. */
export function sampleViewportRange(
  viewport: FrameRange,
  totalFrames: number,
  widthCSS: number,
): FrameRange | undefined {
  const { start, end } = viewport;
  if (
    !Number.isSafeInteger(totalFrames) ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > totalFrames ||
    !Number.isFinite(widthCSS) ||
    widthCSS <= end - start
  )
    return;
  // Clamp BEFORE paging. Boundary neighbors allow clipped connections without
  // inventing samples before frame0 or after the file's final real sample.
  return { start: start > 0 ? start - 1 : 0, end: end < totalFrames ? end + 1 : end };
}
