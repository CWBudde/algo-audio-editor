import { AudioWaveform, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";

interface TransportBarProps {
  ready: boolean;
  playing: boolean;
  frequencyHz: number;
  amplitude: number;
  onPlay(): void;
  onStop(): void;
  onFrequencyChange(hz: number): void;
  onAmplitudeChange(amplitude: number): void;
}

function first(value: number | readonly number[]): number {
  return typeof value === "number" ? value : value[0];
}

export function TransportBar(props: TransportBarProps) {
  const { ready, playing } = props;

  return (
    <div className="flex h-12 items-center gap-3 border-b px-3">
      <Button
        size="icon"
        variant={playing ? "secondary" : "default"}
        disabled={!ready || playing}
        onClick={props.onPlay}
        aria-label="Play test tone"
        data-testid="play"
      >
        <Play />
      </Button>
      <Button
        size="icon"
        variant="outline"
        disabled={!playing}
        onClick={props.onStop}
        aria-label="Stop"
        data-testid="stop"
      >
        <Square />
      </Button>

      <Separator orientation="vertical" className="mx-1 h-6" />

      <AudioWaveform className="size-4 text-muted-foreground" />
      <span className="text-xs text-muted-foreground">Test tone</span>

      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">Freq</span>
        <div className="w-40">
          <Slider
            min={50}
            max={2000}
            step={1}
            value={[props.frequencyHz]}
            disabled={!ready}
            onValueChange={(v) => props.onFrequencyChange(first(v))}
            aria-label="Tone frequency"
          />
        </div>
        <span className="w-16 whitespace-nowrap tabular-nums">{props.frequencyHz} Hz</span>
      </div>

      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">Level</span>
        <div className="w-28">
          <Slider
            min={0}
            max={1}
            step={0.01}
            value={[props.amplitude]}
            disabled={!ready}
            onValueChange={(v) => props.onAmplitudeChange(first(v))}
            aria-label="Tone level"
          />
        </div>
        <span className="w-16 whitespace-nowrap tabular-nums">{formatDb(props.amplitude)}</span>
      </div>
    </div>
  );
}

function formatDb(amplitude: number): string {
  if (amplitude <= 0) return "−∞ dB";
  return `${(20 * Math.log10(amplitude)).toFixed(1)} dB`;
}
