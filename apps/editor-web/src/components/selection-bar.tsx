import type { SelectionRange } from "@aae/protocol";
import { useEffect, useId, useRef, useState } from "react";
import { ControlDisclosure } from "@/components/control-disclosure";
import { Button } from "@/components/ui/button";
import { allChannelsMask, formatSelectionTime, parseSelectionTime } from "@/lib/selection";
import type { TimeFormat } from "@/lib/waveform-geometry";

interface SelectionBarProps {
  selection: SelectionRange;
  frames: number;
  sampleRate: number;
  channels: number;
  timeFormat: TimeFormat;
  disabled?: boolean;
  frameless?: boolean;
  onChange(selection: SelectionRange): void;
}

interface TimeFieldProps {
  label: string;
  frame: number;
  rate: number;
  format: TimeFormat;
  commit(frame: number): string | undefined;
}

interface Draft {
  text: string;
  baseline: string;
  rate: number;
  format: TimeFormat;
  sourceFrame: number;
  error?: string;
}

function TimeField({ label, frame, rate, format, commit }: TimeFieldProps) {
  const [draft, setDraft] = useState<Draft>();
  const focused = useRef(false);
  const errorId = useId();
  const unitId = `${errorId}-unit`;
  const formatted = formatSelectionTime(frame, rate, format);
  useEffect(() => {
    if (!focused.current)
      setDraft((previous) =>
        previous &&
        (previous.sourceFrame !== frame || previous.rate !== rate || previous.format !== format)
          ? undefined
          : previous,
      );
  }, [frame, rate, format]);
  const fresh = (): Draft => ({
    text: formatted,
    baseline: formatted,
    rate,
    format,
    sourceFrame: frame,
  });
  const finish = (blur: boolean) => {
    if (!draft || draft.text === draft.baseline) {
      setDraft(undefined);
      return;
    }
    const parsed = parseSelectionTime(draft.text, draft.rate, draft.format);
    const error = parsed === undefined ? "Enter a valid nonnegative time." : commit(parsed);
    if (error) setDraft({ ...draft, error });
    else setDraft(blur ? undefined : { ...draft, baseline: draft.text, error: undefined });
  };
  return (
    <div className="editor-tool-band shrink-0">
      <label className="flex h-7 items-center gap-1.5 rounded border border-border/60 bg-background/60 px-1.5 text-xs focus-within:border-ring">
        <span
          aria-hidden="true"
          className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
        >
          {label.replace("Selection ", "")}
        </span>
        <input
          type="text"
          inputMode={format === "samples" ? "numeric" : "decimal"}
          aria-label={label}
          aria-invalid={Boolean(draft?.error)}
          aria-describedby={draft?.error ? errorId : unitId}
          className="w-24 min-w-0 bg-transparent py-1 font-mono text-xs tabular-nums focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          value={draft?.text ?? formatted}
          onFocus={() => {
            focused.current = true;
            setDraft((previous) => previous ?? fresh());
          }}
          onChange={(event) =>
            setDraft({ ...(draft ?? fresh()), text: event.target.value, error: undefined })
          }
          onBlur={() => {
            focused.current = false;
            finish(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              finish(false);
            } else if (event.key === "Escape") {
              event.preventDefault();
              setDraft(undefined);
            }
          }}
        />
        <span id={unitId} className="text-[10px] text-muted-foreground">
          {(draft?.format ?? format) === "samples"
            ? "samples"
            : (draft?.format ?? format) === "seconds"
              ? "s"
              : "h:m:s"}
        </span>
      </label>
      {draft?.error && (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {draft.error}
        </p>
      )}
    </div>
  );
}

/** Controlled selection metadata only; sample analysis remains in the kernel. */
export function SelectionBar({
  selection,
  frames,
  sampleRate,
  channels,
  timeFormat,
  disabled = false,
  frameless = false,
  onChange,
}: SelectionBarProps) {
  const all = allChannelsMask(channels);
  const mask =
    Number.isInteger(selection.channelMask) &&
    selection.channelMask > 0 &&
    selection.channelMask <= all
      ? selection.channelMask
      : all;
  const emit = (next: SelectionRange) => {
    if (
      !disabled &&
      (next.start !== selection.start ||
        next.end !== selection.end ||
        next.channelMask !== selection.channelMask)
    )
      onChange(next);
  };
  const commit = (field: "start" | "end" | "length", value: number): string | undefined => {
    const start = field === "start" ? value : selection.start;
    const end =
      field === "end" ? value : field === "length" ? selection.start + value : selection.end;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end > frames
    )
      return "Selection must satisfy 0 ≤ start ≤ end ≤ document length.";
    emit({ start, end, channelMask: mask });
    return undefined;
  };
  const chooseMask = (channelMask: number) => {
    if (channelMask > 0 && channelMask <= all) emit({ ...selection, channelMask });
  };
  return (
    <fieldset
      disabled={disabled}
      className={
        frameless
          ? "contents"
          : "flex shrink-0 flex-wrap items-center gap-x-1 gap-y-1 border-b border-border/60 bg-card px-2 py-1"
      }
      data-testid="selection-bar"
    >
      <legend className="sr-only">Selection</legend>
      <TimeField
        label="Selection start"
        frame={selection.start}
        rate={sampleRate}
        format={timeFormat}
        commit={(value) => commit("start", value)}
      />
      <TimeField
        label="Selection end"
        frame={selection.end}
        rate={sampleRate}
        format={timeFormat}
        commit={(value) => commit("end", value)}
      />
      <TimeField
        label="Selection length"
        frame={selection.end - selection.start}
        rate={sampleRate}
        format={timeFormat}
        commit={(value) => commit("length", value)}
      />
      <ControlDisclosure
        className="editor-tool-band relative shrink-0 text-xs"
        data-testid="channel-settings"
      >
        <summary
          className="flex h-7 cursor-pointer items-center whitespace-nowrap rounded px-1.5 focus-visible:outline-2 focus-visible:outline-ring"
          aria-label="Selected channels"
          title="Choose selected channels"
        >
          Channels:{" "}
          {mask === all
            ? "All"
            : mask === 1 && channels === 2
              ? "Left"
              : mask === 2 && channels === 2
                ? "Right"
                : `${mask.toString(2).replaceAll("0", "").length} / ${channels}`}
        </summary>
        <fieldset
          data-disclosure-panel
          className="absolute right-0 top-full z-40 flex w-64 max-w-[calc(100vw-2rem)] flex-wrap items-center gap-2 rounded border bg-popover p-3 shadow-lg"
          aria-label="Selected channels"
        >
          <legend className="sr-only">Selected channels</legend>
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="editor-channel-choice aria-pressed:border-primary aria-pressed:bg-selection-fill aria-pressed:text-primary dark:aria-pressed:border-primary dark:aria-pressed:bg-selection-fill"
            aria-pressed={mask === all}
            onClick={() => chooseMask(all)}
          >
            All
          </Button>
          {channels === 2 && (
            <>
              <Button
                type="button"
                size="xs"
                variant="outline"
                className="editor-channel-choice aria-pressed:border-primary aria-pressed:bg-selection-fill aria-pressed:text-primary dark:aria-pressed:border-primary dark:aria-pressed:bg-selection-fill"
                aria-pressed={mask === 1}
                onClick={() => chooseMask(1)}
              >
                Left
              </Button>
              <Button
                type="button"
                size="xs"
                variant="outline"
                className="editor-channel-choice aria-pressed:border-primary aria-pressed:bg-selection-fill aria-pressed:text-primary dark:aria-pressed:border-primary dark:aria-pressed:bg-selection-fill"
                aria-pressed={mask === 2}
                onClick={() => chooseMask(2)}
              >
                Right
              </Button>
            </>
          )}
          {Array.from({ length: channels }, (_, channel) => channel).map((channel) => {
            const bit = 2 ** channel;
            const checked = (mask & bit) !== 0;
            return (
              <label key={channel} className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  aria-label={`Channel ${channel + 1} selected`}
                  checked={checked}
                  disabled={disabled || (checked && mask === bit)}
                  onChange={(event) => chooseMask(event.target.checked ? mask | bit : mask & ~bit)}
                />
                Channel {channel + 1}
              </label>
            );
          })}
        </fieldset>
      </ControlDisclosure>
    </fieldset>
  );
}
