export interface FrameRange {
  start: number;
  end: number;
}

export type TimeFormat = "samples" | "seconds" | "hms";
export type AmplitudeScale = "linear" | "db";

export interface TimeTick {
  frame: number;
  x: number;
  label: string;
}

export interface AmplitudeTick {
  value: number;
  y: number;
  label: string;
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

/** Shift a viewport inside the file while retaining its requested frame span. */
export function clampViewport(range: FrameRange, totalFrames: number): FrameRange {
  const total = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(finite(totalFrames))));
  if (total === 0) return { start: 0, end: 0 };
  const requestedStart = finite(range.start);
  const width = Math.min(total, Math.max(1, Math.round(finite(range.end, total) - requestedStart)));
  const start = Math.min(total - width, Math.max(0, Math.round(requestedStart)));
  return { start, end: start + width };
}

/** A factor greater than one zooms in, retaining the frame under the anchor. */
export function zoomViewport(
  range: FrameRange,
  totalFrames: number,
  factor: number,
  anchorRatio = 0.5,
): FrameRange {
  const current = clampViewport(range, totalFrames);
  if (!Number.isFinite(factor) || factor <= 0 || current.end === current.start) return current;
  const ratio = Math.min(1, Math.max(0, finite(anchorRatio, 0.5)));
  const width = Math.max(1, Math.round((current.end - current.start) / factor));
  const anchor = current.start + (current.end - current.start) * ratio;
  return clampViewport(
    { start: anchor - width * ratio, end: anchor + width * (1 - ratio) },
    totalFrames,
  );
}

export function panViewport(
  range: FrameRange,
  totalFrames: number,
  deltaFrames: number,
): FrameRange {
  const current = clampViewport(range, totalFrames);
  const total = clampViewport({ start: 0, end: totalFrames }, totalFrames).end;
  const width = current.end - current.start;
  const start = Math.max(
    0,
    Math.min(total - width, current.start + Math.round(finite(deltaFrames))),
  );
  return { start, end: start + width };
}

/** Map a frame to CSS pixels. Offscreen frames deliberately remain offscreen. */
export function frameToX(frame: number, range: FrameRange, width: number): number {
  if (
    !Number.isFinite(frame) ||
    !Number.isFinite(width) ||
    !Number.isFinite(range.start) ||
    !Number.isFinite(range.end) ||
    width <= 0 ||
    range.end <= range.start
  ) {
    return 0;
  }
  return ((frame - range.start) / (range.end - range.start)) * width;
}

/** Hit testing clamps CSS pixels to the viewport and returns an integer frame. */
export function xToFrame(x: number, range: FrameRange, width: number): number {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(range.start) ||
    !Number.isFinite(range.end) ||
    width <= 0 ||
    range.end <= range.start
  )
    return finite(range.start);
  const ratio = Math.min(1, Math.max(0, finite(x) / width));
  return Math.round(range.start + ratio * (range.end - range.start));
}

export function formatTime(frame: number, sampleRate: number, format: TimeFormat): string {
  const position = Math.max(0, Math.round(finite(frame)));
  if (format === "samples") return position.toLocaleString("en-US");
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 1;
  if (format === "seconds") return `${Number((position / rate).toFixed(6))} s`;
  const millis = Math.round((position / rate) * 1_000);
  const hours = Math.floor(millis / 3_600_000);
  const minutes = Math.floor((millis % 3_600_000) / 60_000);
  const seconds = Math.floor((millis % 60_000) / 1_000);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis % 1_000).padStart(3, "0")}`;
}

function niceInterval(target: number): number {
  const power = 10 ** Math.floor(Math.log10(Math.max(Number.MIN_VALUE, target)));
  const fraction = target / power;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
}

function timeTickStep(
  range: FrameRange,
  width: number,
  sampleRate: number,
  format: TimeFormat,
): number {
  if (
    !Number.isFinite(range.start) ||
    !Number.isFinite(range.end) ||
    range.end <= range.start ||
    !Number.isFinite(width) ||
    width <= 0
  ) {
    return 0;
  }
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 1;
  const desired = Math.min(200, Math.max(1, Math.floor(width / (format === "hms" ? 130 : 90))));
  const targetFrames = (range.end - range.start) / desired;
  let step = Math.max(1, Math.ceil(niceInterval(targetFrames)));
  if (format !== "samples") {
    const targetSeconds = targetFrames / rate;
    let seconds = niceInterval(targetSeconds);
    if (format === "hms" && targetSeconds >= 1) {
      const clockSteps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1_800, 3_600];
      seconds =
        clockSteps.find((value) => value >= targetSeconds) ??
        niceInterval(targetSeconds / 3_600) * 3_600;
    }
    step = Math.max(1, Math.round(seconds * rate));
  }
  return step;
}

/** Tick positions use frame coordinates throughout, including very long files. */
export function generateTimeTicks(
  range: FrameRange,
  width: number,
  sampleRate: number,
  format: TimeFormat = "seconds",
): TimeTick[] {
  const step = timeTickStep(range, width, sampleRate, format);
  if (!step) return [];
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 1;
  const first = Math.ceil(range.start / step) * step;
  const ticks: TimeTick[] = [];
  for (let index = 0; index <= 200; index++) {
    const frame = first + index * step;
    if (frame > range.end) break;
    ticks.push({ frame, x: frameToX(frame, range, width), label: formatTime(frame, rate, format) });
  }
  return ticks;
}

/** Unlabeled ruler subdivisions; the labeled grid remains the snapping grid. */
export function generateTimeSubTicks(
  range: FrameRange,
  width: number,
  sampleRate: number,
  format: TimeFormat = "seconds",
): { frame: number; x: number; kind: "minor" | "medium" }[] {
  const majorStep = timeTickStep(range, width, sampleRate, format);
  if (!majorStep) return [];
  const majorPixels = (majorStep / (range.end - range.start)) * width;
  // Keep marks at least eight CSS pixels apart and on whole sample boundaries.
  const divisions = [10, 5, 2].find((count) => majorStep % count === 0 && majorPixels / count >= 8);
  if (!divisions) return [];
  const step = majorStep / divisions;
  const first = Math.ceil(range.start / step);
  const ticks: ReturnType<typeof generateTimeSubTicks> = [];
  for (let index = 0; index <= 2_000; index++) {
    const ordinal = first + index;
    const frame = ordinal * step;
    if (frame > range.end) break;
    if (ordinal % divisions === 0) continue;
    ticks.push({
      frame,
      x: frameToX(frame, range, width),
      kind: divisions % 2 === 0 && ordinal % divisions === divisions / 2 ? "medium" : "minor",
    });
  }
  return ticks;
}

/** Amplitude coordinates are linear; the dB ruler labels equivalent levels. */
export const VERTICAL_ZOOM_LEVELS = [1, 2, 4, 8, 16, 32, 64] as const;

export function clampVerticalZoom(zoom: number): number {
  return Number.isFinite(zoom) ? Math.max(1, Math.min(64, zoom)) : 1;
}

/** Magnify display coordinates around zero; source amplitudes stay unchanged. */
export function amplitudeToY(value: number, height: number, zoom = 1): number {
  const clipped = Number.isNaN(value)
    ? 0
    : Math.max(-1, Math.min(1, value * clampVerticalZoom(zoom)));
  return ((1 - clipped) / 2) * Math.max(0, finite(height));
}

export function formatAmplitude(value: number, scale: AmplitudeScale): string {
  const clipped = Number.isNaN(value) ? 0 : Math.max(-1, Math.min(1, value));
  if (scale === "linear") return String(Number(clipped.toFixed(Math.abs(clipped) < 0.1 ? 5 : 3)));
  if (clipped === 0) return "−∞";
  return String(Number((20 * Math.log10(Math.abs(clipped))).toFixed(1)));
}

export function generateAmplitudeTicks(
  height: number,
  scale: AmplitudeScale,
  zoom = 1,
): AmplitudeTick[] {
  if (!Number.isFinite(height) || height <= 0) return [];
  const levels = scale === "linear" ? [1, 0.5] : [1, 10 ** (-6 / 20), 10 ** (-12 / 20)];
  const magnification = clampVerticalZoom(zoom);
  const values = (
    height < 100 ? [1, 0, -1] : [...levels, 0, ...levels.toReversed().map((value) => -value)]
  ).map((value) => value / magnification);
  return values.map((value) => ({
    value,
    y: amplitudeToY(value, height, magnification),
    label: formatAmplitude(value, scale),
  }));
}
