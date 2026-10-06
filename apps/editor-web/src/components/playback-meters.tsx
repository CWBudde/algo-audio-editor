import { useEffect, useRef } from "react";
import type { MeterSnapshot } from "@/audio/meter-data";
import { Button } from "@/components/ui/button";
import { resolveEditorPalette } from "@/lib/editor-theme";
import { resizeCanvas } from "@/lib/waveform-drawing";

export function amplitudeDB(value: number): number {
  return value > 0 && Number.isFinite(value) ? 20 * Math.log10(value) : -Infinity;
}
export function meterNumber(value: number | undefined, unit: string): string {
  return value !== undefined && Number.isFinite(value)
    ? `${value.toFixed(1)} ${unit}`
    : `−∞ ${unit}`;
}
function levelWidth(amplitude: number) {
  return Math.max(0, Math.min(100, (amplitudeDB(amplitude) + 60) / 0.6));
}

function Goniometer({ snapshot }: { snapshot?: MeterSnapshot }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const ctx = resizeCanvas(element, 160, 100);
    if (!ctx) return;
    const palette = resolveEditorPalette(element);
    ctx.clearRect(0, 0, 160, 100);
    ctx.strokeStyle = palette.waveformCenter;
    ctx.beginPath();
    ctx.moveTo(80, 0);
    ctx.lineTo(80, 100);
    ctx.moveTo(0, 50);
    ctx.lineTo(160, 50);
    ctx.stroke();
    ctx.fillStyle = palette.primary;
    const points = snapshot?.goniometer;
    if (points)
      for (let i = 0; i < points.length; i += 2) {
        // Coordinate mapping of kernel-computed mid/side points, not DSP.
        ctx.fillRect(
          80 + Math.max(-1, Math.min(1, points[i + 1])) * 78,
          50 - Math.max(-1, Math.min(1, points[i])) * 48,
          2,
          2,
        );
      }
  }, [snapshot]);
  return (
    <canvas
      ref={canvas}
      width={160}
      height={100}
      role="img"
      aria-label="Mid/side goniometer"
      className="effect-graph shrink-0 rounded border"
    />
  );
}

export function PlaybackMeters({
  snapshot,
  error,
  onReset,
  onClose,
}: {
  snapshot?: MeterSnapshot;
  error?: string;
  onReset(): void;
  onClose(): void;
}) {
  const provisional = !snapshot?.rangeStable;
  const failure = snapshot?.failure
    ? ["", "nonfinite audio", "measurement capacity exceeded", "arithmetic failure"][
        snapshot.failure
      ]
    : undefined;
  return (
    <section
      aria-label="Playback output meters"
      className="analysis-panel min-h-0 min-w-0 overflow-auto bg-card p-3"
    >
      <div className="analysis-panel-header mb-2 flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-xs font-semibold">Output meters</h2>
        <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={onReset}>
          Reset holds and loudness
        </Button>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={onClose}>
          Close meters
        </Button>
      </div>
      <p className="mb-3 text-[10px] text-muted-foreground">Rendered ahead of the output device</p>
      {(error || failure) && (
        <p role="alert">{error ?? `Metering stopped: ${failure}. Reset to retry.`}</p>
      )}
      <div className="analysis-meter-body min-w-0">
        <div className="analysis-meter-channels min-w-0 space-y-3">
          {snapshot?.channels.map((channel) => (
            <fieldset
              key={`channel-${channel.channel + 1}`}
              aria-label={`Channel ${channel.channel + 1} levels`}
              className="text-xs"
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="font-medium">Channel {channel.channel + 1}</span>
                <span aria-hidden="true" className="text-[10px] text-muted-foreground">
                  −60 · −30 · 0 dBFS
                </span>
              </div>
              <meter
                min={-60}
                max={6}
                value={Math.max(-60, Math.min(6, amplitudeDB(channel.peak)))}
                className="sr-only"
                aria-label={`Channel ${channel.channel + 1} peak`}
                aria-valuemin={-60}
                aria-valuemax={6}
                aria-valuenow={
                  Number.isFinite(amplitudeDB(channel.peak))
                    ? Math.max(-60, Math.min(6, amplitudeDB(channel.peak)))
                    : -60
                }
              />
              <div
                aria-hidden="true"
                className="relative h-2.5 overflow-hidden rounded-sm bg-muted"
              >
                <span
                  className={`absolute inset-y-0 left-0 ${channel.truePeak > 1 ? "bg-destructive" : "bg-primary"}`}
                  style={{ width: `${levelWidth(channel.peak)}%` }}
                />
                <span
                  className="absolute inset-y-1 left-0 bg-waveform-peak"
                  style={{ width: `${levelWidth(channel.rms)}%` }}
                />
                <span
                  className="absolute inset-y-0 w-px bg-foreground"
                  style={{ left: `${levelWidth(channel.hold)}%` }}
                />
              </div>
              <dl className="analysis-channel-levels mt-1 grid gap-x-2 gap-y-1">
                {[
                  { label: "Peak", amplitude: channel.peak, unit: "dBFS" },
                  { label: "RMS", amplitude: channel.rms, unit: "dBFS" },
                  { label: "Hold", amplitude: channel.hold, unit: "dBFS" },
                  { label: "True peak", amplitude: channel.truePeak, unit: "dBTP" },
                ].map(({ label, amplitude, unit }) => (
                  <div key={label} className="min-w-0">
                    <dt className="text-[10px] text-muted-foreground">{label}</dt>
                    <dd
                      className={`analysis-number whitespace-nowrap text-[11px] tabular-nums ${label === "True peak" && channel.truePeak > 1 ? "text-destructive" : "text-foreground"}`}
                    >
                      {meterNumber(amplitudeDB(amplitude), unit)}
                    </dd>
                  </div>
                ))}
              </dl>
            </fieldset>
          )) ?? <p className="text-xs text-muted-foreground">Play audio to read channel levels.</p>}
        </div>
        <dl className="analysis-loudness-grid grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1.5 text-[11px] tabular-nums">
          <dt>Momentary</dt>
          <dd>{meterNumber(snapshot?.momentary, "LUFS")}</dd>
          <dt>Maximum momentary</dt>
          <dd>{meterNumber(snapshot?.maximumMomentary, "LUFS")}</dd>
          <dt>Short-term</dt>
          <dd>{meterNumber(snapshot?.shortTerm, "LUFS")}</dd>
          <dt>Maximum short-term</dt>
          <dd>{meterNumber(snapshot?.maximumShortTerm, "LUFS")}</dd>
          <dt>Integrated</dt>
          <dd>{meterNumber(snapshot?.integrated, "LUFS")}</dd>
          <dt>Loudness range</dt>
          <dd>
            {meterNumber(snapshot?.range, "LU")}
            {provisional ? " (provisional, first 60 s)" : ""}
          </dd>
          <dt>Phase correlation</dt>
          <dd>
            {snapshot?.channels.length &&
            snapshot.channels.length >= 2 &&
            Number.isFinite(snapshot.correlation)
              ? snapshot.correlation.toFixed(3)
              : "Stereo required"}
          </dd>
        </dl>
        <div className="analysis-meter-image space-y-1">
          <p className="text-[10px] text-muted-foreground">Stereo image · mid / side</p>
          <Goniometer snapshot={snapshot} />
        </div>
        <p className="analysis-meter-footer text-[10px] text-muted-foreground">
          Loudness measurement:{" "}
          {((snapshot?.loudnessFrames ?? 0) / (snapshot?.sampleRate ?? 48000)).toFixed(1)} s ·{" "}
          {(snapshot?.availability ?? 0) & 4
            ? "integrated gate available"
            : "waiting for gated measurement"}
        </p>
      </div>
    </section>
  );
}
