const CHANNEL_HEADER_HEIGHT = 25;
const FALLBACK_LANE_HEIGHT = 160;
const MIN_LANE_HEIGHT = 96;
const MAX_LANE_HEIGHT = 1024;

/** Divide the visible workspace between channels; dense documents scroll rather than collapse. */
export function waveformLaneHeight(availableHeight: number, channels: number, split: boolean) {
  if (!Number.isFinite(availableHeight) || availableHeight <= 0) return FALLBACK_LANE_HEIGHT;
  const count = Math.max(1, Math.floor(channels));
  const panels = split ? 2 : 1;
  return Math.max(
    MIN_LANE_HEIGHT,
    Math.min(
      MAX_LANE_HEIGHT,
      Math.floor((availableHeight / count - CHANNEL_HEADER_HEIGHT) / panels),
    ),
  );
}
