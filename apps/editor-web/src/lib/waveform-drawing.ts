import type { PeakViews } from "@/kernel/peak-data";
import { amplitudeToY, type FrameRange, frameToX } from "./waveform-geometry";
import type { SampleDisplayMode } from "./waveform-samples";

export interface WaveformColors {
  background?: string;
  peakColor?: string;
  rmsColor?: string;
  sampleColor?: string;
  showRMS?: boolean;
}

/** Draw exact single-frame kernel summaries as geometry, never audio DSP.
 * Linear joins actual adjacent points; steps holds each value for its frame.
 * Pages may contain one offscreen neighbor at each boundary. */
export function drawSampleWaveform(
  ctx: CanvasRenderingContext2D,
  pages: readonly PeakViews[] | null | undefined,
  range: FrameRange,
  width: number,
  height: number,
  mode: SampleDisplayMode = "linear",
  colors: WaveformColors = {},
): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
  ctx.clearRect(0, 0, width, height);
  if (colors.background) {
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, width, height);
  }
  if (
    !pages ||
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 0 ||
    range.end <= range.start
  )
    return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();
  ctx.strokeStyle = colors.peakColor ?? "#2dd4bf";
  ctx.fillStyle = colors.peakColor ?? "#2dd4bf";
  ctx.lineWidth = 1;
  ctx.beginPath();
  let previousFrame = Number.NaN;
  for (const page of pages) {
    for (let index = 0; index < page.frameCounts.length; index++) {
      const frame = page.startFrames[index];
      // An aggregate bucket is NEVER an inferred sample. NaNs break the path;
      // infinities follow the existing display-only full-scale clipping rule.
      const value = page.peaks[index * 3];
      if (
        page.frameCounts[index] !== 1 ||
        !Number.isSafeInteger(frame) ||
        frame < 0 ||
        !Number.isSafeInteger(frame + 1) ||
        typeof value !== "number" ||
        Number.isNaN(value)
      ) {
        previousFrame = Number.NaN;
        continue;
      }
      const x = frameToX(frame, range, width);
      const y = amplitudeToY(value, height);
      if (frame === previousFrame + 1) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      if (mode === "steps") ctx.lineTo(frameToX(frame + 1, range, width), y);
      previousFrame = frame;
    }
  }
  ctx.stroke();
  // One fill path for visible dots, independent of page seams or DPR. Context
  // neighbors contribute connections but never phantom offscreen sample dots.
  const radius = Math.min(2.5, Math.max(0.75, (width / (range.end - range.start)) * 0.25));
  ctx.fillStyle = colors.sampleColor ?? colors.peakColor ?? "#2dd4bf";
  ctx.beginPath();
  for (const page of pages) {
    for (let index = 0; index < page.frameCounts.length; index++) {
      const frame = page.startFrames[index];
      const value = page.peaks[index * 3];
      if (
        page.frameCounts[index] !== 1 ||
        !Number.isSafeInteger(frame) ||
        frame < range.start ||
        frame >= range.end ||
        typeof value !== "number" ||
        Number.isNaN(value)
      )
        continue;
      const x = frameToX(frame, range, width);
      const y = amplitudeToY(value, height);
      ctx.moveTo(x + radius, y);
      ctx.arc(x, y, radius, 0, Math.PI * 2);
    }
  }
  ctx.fill();
  ctx.restore();
}

/** Size the backing bitmap for DPR while all drawing continues in CSS pixels. */
export function resizeCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  dpr = globalThis.devicePixelRatio ?? 1,
): CanvasRenderingContext2D | null {
  const cssWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const cssHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const bitmapWidth = Math.round(cssWidth * ratio);
  const bitmapHeight = Math.round(cssHeight * ratio);
  if (canvas.width !== bitmapWidth) canvas.width = bitmapWidth;
  if (canvas.height !== bitmapHeight) canvas.height = bitmapHeight;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  const ctx = canvas.getContext("2d");
  ctx?.setTransform(ratio, 0, 0, ratio, 0, 0);
  return ctx;
}

/** Draw only kernel summaries, retaining their true time extent at every zoom. */
export function drawWaveform(
  ctx: CanvasRenderingContext2D,
  peaks: PeakViews | null,
  range: FrameRange,
  width: number,
  height: number,
  colors: WaveformColors = {},
): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
  ctx.clearRect(0, 0, width, height);
  if (colors.background) {
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, width, height);
  }
  if (!peaks || range.end <= range.start) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();
  ctx.fillStyle = colors.peakColor ?? "#2dd4bf";
  for (let index = 0; index < peaks.frameCounts.length; index++) {
    const start = peaks.startFrames[index];
    const end = start + peaks.frameCounts[index];
    if (end <= range.start || start >= range.end) continue;
    const minimum = peaks.peaks[index * 3];
    const maximum = peaks.peaks[index * 3 + 1];
    if (Number.isNaN(minimum) || Number.isNaN(maximum)) continue;
    const left = frameToX(Math.max(start, range.start), range, width);
    const right = frameToX(Math.min(end, range.end), range, width);
    const top = amplitudeToY(maximum, height);
    const bottom = amplitudeToY(minimum, height);
    ctx.fillRect(left, top, Math.max(1, right - left), Math.max(1, bottom - top));
  }
  if (colors.showRMS !== false) {
    ctx.fillStyle = colors.rmsColor ?? "#0f766e";
    ctx.strokeStyle = colors.rmsColor ?? "#0f766e";
    ctx.lineWidth = 1;
    ctx.beginPath();
    let connected = false;
    let previousEnd = Number.NaN;
    for (let index = 0; index < peaks.frameCounts.length; index++) {
      const start = peaks.startFrames[index];
      const end = start + peaks.frameCounts[index];
      if (end <= range.start || start >= range.end) continue;
      const rms = peaks.peaks[index * 3 + 2];
      if (Number.isNaN(rms)) continue;
      const left = frameToX(Math.max(start, range.start), range, width);
      const right = frameToX(Math.min(end, range.end), range, width);
      const top = amplitudeToY(rms, height);
      const bottom = amplitudeToY(-rms, height);
      ctx.fillRect(left, top, Math.max(1, right - left), Math.max(1, bottom - top));
      const middle = (left + right) / 2;
      if (connected && start === previousEnd) ctx.lineTo(middle, top);
      else ctx.moveTo(middle, top);
      connected = true;
      previousEnd = end;
    }
    ctx.stroke();
  }
  ctx.restore();
}
