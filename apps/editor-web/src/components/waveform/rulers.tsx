import type { generateAmplitudeTicks, generateTimeTicks } from "@/lib/waveform-geometry";

export function TimeRuler({ ticks: timeTicks }: { ticks: ReturnType<typeof generateTimeTicks> }) {
  return (
    <>
      {timeTicks.map((tick) => (
        <span
          key={tick.frame}
          className="absolute top-0 h-full border-l border-border"
          style={{ left: tick.x }}
        >
          <span className="absolute left-1 top-1 whitespace-nowrap text-[10px] tabular-nums">
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
      className="relative border-r"
      style={{ height }}
      data-testid={`waveform-amplitude-ruler-${channel}`}
    >
      {ticks.map((tick) => (
        <span
          key={tick.value}
          className="absolute right-1 -translate-y-1/2 text-[10px] tabular-nums text-muted-foreground"
          style={{ top: Math.max(7, Math.min(height - 7, tick.y)) }}
        >
          {tick.label}
        </span>
      ))}
    </div>
  );
}
