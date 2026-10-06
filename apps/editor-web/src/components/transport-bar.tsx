import { type Ref, useCallback, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { ControlDisclosure } from "@/components/control-disclosure";
import { IconAction } from "@/components/icon-action";
import type { CommandId, ResolvedCommand } from "@/lib/commands";
import { Play, Repeat2, Settings2, Square } from "@/lib/icons";

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
  frameless?: boolean;
  commands?: readonly ResolvedCommand[];
  onExecute?(id: CommandId): void;
  ref?: Ref<TransportBarHandle>;
  readPosition?(): number;
  onPlay(): void;
  onStop(): void;
  onLoopChange(loop: boolean): void;
  onFollowChange(follow: PlaybackFollow): void;
}

export function TransportBar(props: TransportBarProps) {
  const { ready, playing } = props;
  const playCommand = props.commands?.find((command) => command.id === "transport.toggle-playback");
  const stopCommand = props.commands?.find((command) => command.id === "transport.stop");
  const readout = useRef<HTMLOutputElement>(null);
  const secondsReadout = useRef<HTMLSpanElement>(null);
  const framesReadout = useRef<HTMLSpanElement>(null);
  const updatePosition = useCallback(
    (frame: number) => {
      const element = readout.current;
      if (!element) return;
      element.dataset.frame = String(frame);
      if (secondsReadout.current)
        secondsReadout.current.textContent = `${(frame / props.sampleRate).toFixed(3)} s`;
      if (framesReadout.current) framesReadout.current.textContent = ` · ${frame} frames`;
    },
    [props.sampleRate],
  );
  useImperativeHandle(props.ref, () => ({ updatePosition }), [updatePosition]);
  // React commits unrelated controls/stats asynchronously. Refresh from the
  // shared clock at commit so they cannot overwrite an up-to-date RAF cursor.
  useLayoutEffect(() => updatePosition(props.readPosition?.() ?? props.position));

  return (
    <fieldset
      aria-label="Playback"
      className={
        props.frameless
          ? "transport-controls contents"
          : "transport-controls flex min-h-9 flex-wrap items-center gap-1 border-b px-2 py-1"
      }
    >
      <div className="editor-tool-band flex shrink-0 items-center gap-0.5">
        <IconAction
          icon={Play}
          label="Play"
          variant={playing ? "secondary" : "default"}
          disabled={!ready || playing || Boolean(props.commands && !playCommand?.enabled)}
          onClick={() =>
            props.onExecute ? props.onExecute("transport.toggle-playback") : props.onPlay()
          }
          shortcutLabel={playCommand?.shortcutLabel ?? "Space"}
          ariaShortcut={playCommand?.ariaShortcut ?? "Space"}
          testId="play"
        />
        <IconAction
          icon={Square}
          label="Stop"
          disabled={props.commands ? !stopCommand?.enabled : !playing}
          onClick={() => (props.onExecute ? props.onExecute("transport.stop") : props.onStop())}
          shortcutLabel="Space"
          testId="stop"
        />
        <label
          className="editor-toggle relative flex size-7 cursor-pointer items-center justify-center rounded-md has-[:focus-visible]:ring-2 has-[:disabled]:cursor-default has-[:disabled]:opacity-50"
          title="Loop"
        >
          <input
            type="checkbox"
            className="absolute inset-0 z-10 m-0 size-full cursor-pointer opacity-0 disabled:cursor-default"
            checked={props.loop}
            disabled={!ready || playing}
            onChange={(event) => props.onLoopChange(event.target.checked)}
          />
          <Repeat2 className="pointer-events-none size-4" aria-hidden="true" />
          <span className="sr-only">Loop</span>
        </label>
        <ControlDisclosure className="relative">
          <summary
            className="flex size-7 cursor-pointer list-none items-center justify-center rounded-md hover:bg-muted focus-visible:outline-ring"
            title="Playback settings"
          >
            <Settings2 className="size-4" aria-hidden="true" />
            <span className="sr-only">Playback settings</span>
          </summary>
          <div
            data-disclosure-panel
            className="absolute left-0 top-full z-40 mt-1 w-56 max-w-[calc(100vw-1rem)] rounded-md border bg-popover p-3 text-popover-foreground shadow-lg"
          >
            <label className="flex flex-wrap items-center gap-1.5 text-xs">
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
          </div>
        </ControlDisclosure>
      </div>
      <output
        ref={readout}
        className="editor-tool-band transport-readout flex h-7 shrink-0 items-baseline whitespace-nowrap rounded border px-1.5 py-1 font-mono tabular-nums"
        aria-label="Playback position"
        aria-live="off"
        data-testid="play-position"
        data-frame={props.position}
      >
        <span ref={secondsReadout} className="text-xs font-medium tracking-tight">
          {(props.position / props.sampleRate).toFixed(3)} s
        </span>
        <span ref={framesReadout} className="text-[10px] text-muted-foreground">
          {" · "}
          {props.position} frames
        </span>
      </output>
    </fieldset>
  );
}
