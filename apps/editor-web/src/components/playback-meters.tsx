import { useEffect, useRef } from "react";
import type { MeterSnapshot } from "@/audio/meter-data";
import { Button } from "@/components/ui/button";

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
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, 160, 100);
    ctx.strokeStyle = "#64748b";
    ctx.beginPath();
    ctx.moveTo(80, 0);
    ctx.lineTo(80, 100);
    ctx.moveTo(0, 50);
    ctx.lineTo(160, 50);
    ctx.stroke();
    ctx.fillStyle = "#a855f7";
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
      className="h-24 w-40 rounded border"
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
    <section aria-label="Playback output meters" className="border-t bg-muted/20 p-3">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="mr-auto text-sm font-medium">Output meters</h2>
        <span className="text-xs text-muted-foreground">Rendered ahead of the output device</span>
        <Button size="sm" variant="outline" onClick={onReset}>
          Reset holds and loudness
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close meters
        </Button>
      </div>
      {(error || failure) && (
        <p role="alert">{error ?? `Metering stopped: ${failure}. Reset to retry.`}</p>
      )}
      <div className="flex flex-wrap gap-4">
        <div className="min-w-48 flex-1 space-y-2">
          {snapshot?.channels.map((channel) => (
            <div key={`channel-${channel.channel + 1}`} className="text-xs">
              <div className="flex justify-between">
                <span>Channel {channel.channel + 1}</span>
                <span>
                  Peak {meterNumber(amplitudeDB(channel.peak), "dBFS")} · RMS{" "}
                  {meterNumber(amplitudeDB(channel.rms), "dBFS")} · Hold{" "}
                  {meterNumber(amplitudeDB(channel.hold), "dBFS")} · True peak{" "}
                  {meterNumber(amplitudeDB(channel.truePeak), "dBTP")}
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
                className="relative mt-1 h-3 overflow-hidden rounded bg-muted"
              >
                <span
                  className={`absolute inset-y-0 left-0 ${channel.truePeak > 1 ? "bg-destructive" : "bg-purple-500"}`}
                  style={{ width: `${levelWidth(channel.peak)}%` }}
                />
                <span
                  className="absolute inset-y-1 left-0 bg-amber-400"
                  style={{ width: `${levelWidth(channel.rms)}%` }}
                />
                <span
                  className="absolute inset-y-0 w-px bg-foreground"
                  style={{ left: `${levelWidth(channel.hold)}%` }}
                />
              </div>
            </div>
          )) ?? <p className="text-xs text-muted-foreground">Play audio to read channel levels.</p>}
        </div>
        <dl className="grid grid-cols-2 gap-x-4 text-xs">
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
        <Goniometer snapshot={snapshot} />
        <p className="basis-full text-xs text-muted-foreground">
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
