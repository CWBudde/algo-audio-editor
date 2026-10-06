export interface FrequencyTick {
  hz: number;
  y: number;
  labelY: number;
  value: string;
  unit: "Hz" | "kHz";
}

const LABEL_INSET = 8;
const MIN_LABEL_SPACING = 24;

/** Presentation-only linear coordinates match the kernel's spectral image and selection axes. */
export function frequencyTicks(sampleRate: number, height: number): FrequencyTick[] {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(height) || height <= 0)
    return [];
  const nyquist = sampleRate / 2;
  if (nyquist <= 0) return [];
  const labelY = (y: number) => Math.max(LABEL_INSET, Math.min(height - LABEL_INSET, y));
  const tick = (hz: number): FrequencyTick => {
    const y = (1 - hz / nyquist) * height;
    const unit = hz >= 1000 ? "kHz" : "Hz";
    return { hz, y, labelY: labelY(y), value: String(hz / (unit === "kHz" ? 1000 : 1)), unit };
  };
  const count = Math.max(
    2,
    Math.min(32, Math.floor((height - 2 * LABEL_INSET) / MIN_LABEL_SPACING) + 1),
  );
  const target = nyquist / (count - 1);
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const step = ([1, 2, 5, 10].find((factor) => factor * magnitude >= target) ?? 10) * magnitude;
  const result = [tick(nyquist)];
  const bottom = tick(0);
  if (!Number.isFinite(step) || step <= 0) return [...result, bottom];
  // Reserve both true endpoints, dropping nearby interior labels rather than rounding Nyquist.
  for (let index = Math.ceil(nyquist / step) - 1; index > 0; index--) {
    const candidate = tick(Number((index * step).toPrecision(12)));
    if (
      candidate.labelY - result[result.length - 1].labelY < MIN_LABEL_SPACING ||
      bottom.labelY - candidate.labelY < MIN_LABEL_SPACING
    )
      continue;
    result.push(candidate);
  }
  if (result.length === 1 && bottom.labelY - result[0].labelY >= 2 * MIN_LABEL_SPACING)
    result.push(tick(nyquist / 2));
  result.push(bottom);
  return result;
}

export function FrequencyRuler({
  sampleRate,
  height,
  channel,
}: {
  sampleRate: number;
  height: number;
  channel: number;
}) {
  const ticks = frequencyTicks(sampleRate, height);
  return (
    <div
      className="waveform-frequency-ruler relative border-r"
      style={{ height }}
      role="img"
      aria-label={`Channel ${channel + 1} linear frequency scale, 0 to ${sampleRate / 2} Hz`}
      data-testid={`spectrogram-frequency-ruler-${channel}`}
      data-scale="linear"
      data-nyquist-hz={sampleRate / 2}
    >
      {ticks.map((tick) => (
        <span
          key={tick.hz}
          data-frequency-hz={tick.hz}
          data-frequency-y={tick.y}
          className="absolute right-1 flex -translate-y-1/2 items-baseline gap-px whitespace-nowrap text-muted-foreground"
          style={{ top: tick.labelY }}
          title={`${tick.hz} Hz`}
        >
          <span className="font-mono text-[9px] tabular-nums">{tick.value}</span>{" "}
          <span className="text-[7px]">{tick.unit}</span>
        </span>
      ))}
    </div>
  );
}
