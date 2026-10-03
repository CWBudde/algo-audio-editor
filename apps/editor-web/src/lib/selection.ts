import type { SelectionRange } from "@aae/protocol";
import type { TimeFormat } from "./waveform-geometry";

const MAX_FRAME = BigInt(Number.MAX_SAFE_INTEGER);
const FRACTION_SCALE = 1_000_000_000n;

function validRate(rate: number): boolean {
  return Number.isInteger(rate) && rate >= 1 && rate <= 384_000;
}

/** Nine decimal places resolve every sample at supported rates without float arithmetic. */
export function formatSelectionTime(frame: number, rate: number, format: TimeFormat): string {
  if (!Number.isSafeInteger(frame) || frame < 0 || !validRate(rate)) {
    throw new RangeError(
      "selection time requires a nonnegative safe frame and integer rate 1..384000",
    );
  }
  const value = BigInt(frame);
  if (format === "samples") return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const divisor = BigInt(rate);
  const seconds = value / divisor;
  const fraction = (((value % divisor) * FRACTION_SCALE) / divisor)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/, "");
  if (format === "seconds") return `${seconds}${fraction ? `.${fraction}` : ""}`;
  const hours = seconds / 3600n;
  const minutes = (seconds / 60n) % 60n;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds % 60n).padStart(2, "0")}.${fraction.padEnd(3, "0")}`;
}

/** Parse exact nonnegative decimal time; round to the nearest frame, ties forward. */
export function parseSelectionTime(
  text: string,
  rate: number,
  format: TimeFormat,
): number | undefined {
  if (!validRate(rate) || text.length > 128) return undefined;
  const input = text.trim();
  if (format === "samples") {
    if (!/^(?:\d+|[1-9]\d{0,2}(?:,\d{3})+)$/.test(input)) return undefined;
    const frame = BigInt(input.replaceAll(",", ""));
    return frame <= MAX_FRAME ? Number(frame) : undefined;
  }
  let whole: bigint;
  let fraction: string;
  if (format === "seconds") {
    const match = /^(\d+)(?:\.(\d{1,18}))?(?:\s*s)?$/.exec(input);
    if (!match) return undefined;
    whole = BigInt(match[1]);
    fraction = match[2] ?? "";
  } else if (format === "hms") {
    const match = /^(\d+):([0-5]\d):([0-5]\d)(?:\.(\d{1,18}))?$/.exec(input);
    if (!match) return undefined;
    whole = BigInt(match[1]) * 3600n + BigInt(match[2]) * 60n + BigInt(match[3]);
    fraction = match[4] ?? "";
  } else return undefined;
  const scale = 10n ** BigInt(fraction.length);
  const numerator = (whole * scale + BigInt(fraction || "0")) * BigInt(rate);
  const frame = (numerator * 2n + scale) / (scale * 2n);
  return frame <= MAX_FRAME ? Number(frame) : undefined;
}

/** Coordinate-only snapping; ignored candidates never change document bounds. */
export function snapSelectionFrame(
  frame: number,
  candidates: readonly number[],
  threshold: number,
  total: number,
): number {
  const limit = Number.isFinite(total)
    ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(total)))
    : 0;
  const origin = Number.isFinite(frame) ? Math.max(0, Math.min(limit, Math.round(frame))) : 0;
  if (!Number.isFinite(threshold) || threshold < 0) return origin;
  let nearest = origin;
  let distance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (!Number.isSafeInteger(candidate) || candidate < 0 || candidate > limit) continue;
    const current = Math.abs(candidate - origin);
    if (
      current <= threshold &&
      (current < distance || (current === distance && candidate < nearest))
    ) {
      nearest = candidate;
      distance = current;
    }
  }
  return nearest;
}

/** Extend from a stable anchor (the current start by default), preserving channels. */
export function extendSelection(
  selection: SelectionRange,
  frame: number,
  anchor = selection.start,
): SelectionRange {
  const position = snapSelectionFrame(frame, [], 0, Number.MAX_SAFE_INTEGER);
  const fixed = snapSelectionFrame(anchor, [], 0, Number.MAX_SAFE_INTEGER);
  return {
    start: Math.min(fixed, position),
    end: Math.max(fixed, position),
    channelMask: selection.channelMask,
  };
}

export function allChannelsMask(channels: number): number {
  if (!Number.isInteger(channels) || channels < 1 || channels > 8)
    throw new RangeError("selection channels must be in 1..8");
  return 2 ** channels - 1;
}
