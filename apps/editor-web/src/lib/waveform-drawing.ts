import type { PeakViews } from "@/kernel/peak-data";
import { amplitudeToY, type FrameRange, frameToX } from "./waveform-geometry";

export interface WaveformColors {
  background?: string;
  peakColor?: string;
  rmsColor?: string;
  showRMS?: boolean;
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
