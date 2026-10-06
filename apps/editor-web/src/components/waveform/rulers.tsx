import type { generateAmplitudeTicks, generateTimeTicks } from "@/lib/waveform-geometry";

export function TimeRuler({ ticks: timeTicks }: { ticks: ReturnType<typeof generateTimeTicks> }) {
  return (
    <>
      {timeTicks.map((tick) => (
        <span
          key={tick.frame}
          className="waveform-time-tick absolute top-0 h-full border-l border-border"
          style={{ left: tick.x }}
        >
          <span className="absolute left-1.5 top-1 whitespace-nowrap font-mono text-[10px] tabular-nums text-muted-foreground">
            {tick.label}
          </span>
        </span>
      ))}
    </>
  );
}
export function AmplitudeRuler({
  ticks,
  height,
  channel,
}: {
  ticks: ReturnType<typeof generateAmplitudeTicks>;
  height: number;
  channel: number;
}) {
  return (
    <div
      className="waveform-amplitude-ruler relative border-r"
      style={{ height }}
      data-testid={`waveform-amplitude-ruler-${channel}`}
    >
      {ticks.map((tick) => (
        <span
          key={tick.value}
          className="absolute right-2 -translate-y-1/2 font-mono text-[10px] tabular-nums text-muted-foreground"
          style={{ top: Math.max(7, Math.min(height - 7, tick.y)) }}
        >
          {tick.label}
        </span>
      ))}
    </div>
  );
}
