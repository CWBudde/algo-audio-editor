import { Play, Square } from "lucide-react";
import { type Ref, useCallback, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

export type PlaybackFollow = "off" | "page" | "continuous";

export interface TransportBarHandle {
  updatePosition(frame: number): void;
}

interface TransportBarProps {
  ready: boolean;
  playing: boolean;
  loop: boolean;
  follow: PlaybackFollow;
  position: number;
  sampleRate: number;
  ref?: Ref<TransportBarHandle>;
  readPosition?(): number;
  onPlay(): void;
  onStop(): void;
  onLoopChange(loop: boolean): void;
  onFollowChange(follow: PlaybackFollow): void;
}

export function TransportBar(props: TransportBarProps) {
  const { ready, playing } = props;
  const readout = useRef<HTMLOutputElement>(null);
  const updatePosition = useCallback(
    (frame: number) => {
      const element = readout.current;
      if (!element) return;
      element.dataset.frame = String(frame);
      element.textContent = `${(frame / props.sampleRate).toFixed(3)} s · ${frame} frames`;
    },
    [props.sampleRate],
  );
  useImperativeHandle(props.ref, () => ({ updatePosition }), [updatePosition]);
  // React commits unrelated controls/stats asynchronously. Refresh from the
  // shared clock at commit so they cannot overwrite an up-to-date RAF cursor.
  useLayoutEffect(() => updatePosition(props.readPosition?.() ?? props.position));

  return (
    <div className="flex h-12 items-center gap-3 border-b px-3">
      <Button
        size="icon"
        variant={playing ? "secondary" : "default"}
        disabled={!ready || playing}
        onClick={props.onPlay}
        aria-label="Play"
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

      <label className="flex items-center gap-1.5 text-xs">
        <input
          type="checkbox"
          checked={props.loop}
          disabled={!ready || playing}
          onChange={(event) => props.onLoopChange(event.target.checked)}
        />
        Loop
      </label>
      <label className="flex items-center gap-1.5 text-xs">
        Follow playback
        <select
          className="rounded border bg-background p-1"
          aria-label="Follow playback"
          value={props.follow}
          onChange={(event) => props.onFollowChange(event.target.value as PlaybackFollow)}
        >
          <option value="off">Off</option>
          <option value="page">Page</option>
          <option value="continuous">Continuous</option>
        </select>
      </label>
      <output
        ref={readout}
        className="ml-auto text-xs tabular-nums"
        aria-label="Playback position"
        aria-live="off"
        data-testid="play-position"
        data-frame={props.position}
      >
        {(props.position / props.sampleRate).toFixed(3)} s · {props.position} frames
      </output>
    </div>
  );
}
