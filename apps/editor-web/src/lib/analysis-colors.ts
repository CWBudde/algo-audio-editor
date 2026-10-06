// Preserve physical channel identity in every analysis view, including selected subsets.
// Four colors paired with solid/dashed traces distinguish all eight supported channels.
const CHANNEL_COLORS = [
  "text-waveform-peak",
  "text-trace-secondary",
  "text-trace-tertiary",
  "text-trace-quaternary",
] as const;

export function analysisChannelStyle(channel: number) {
  return {
    color: CHANNEL_COLORS[channel % CHANNEL_COLORS.length],
    dash: channel < 4 ? undefined : "5 3",
  };
}
