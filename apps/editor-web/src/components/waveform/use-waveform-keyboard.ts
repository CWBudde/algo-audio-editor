import type { DocumentInfoResult, SelectionRange } from "@aae/protocol";
import { type KeyboardEvent, useCallback, useLayoutEffect, useRef } from "react";

type Edge = "start" | "end";
interface Caret {
  anchor: number;
  frame: number;
  selection: SelectionRange;
}

interface KeyboardOptions {
  info: DocumentInfoResult;
  session: unknown;
  getSelection(): SelectionRange;
  disabled: boolean;
  hasPreview(): boolean;
  interacting: boolean;
  change(range: SelectionRange, seekFrame?: number): void;
  flush(): void;
  cancel(): void;
  ownsPreview(): boolean;
  interrupt(): void;
  reveal(frame: number): void;
}

function equalRange(left: SelectionRange, right: SelectionRange) {
  return (
    left.start === right.start && left.end === right.end && left.channelMask === right.channelMask
  );
}

function navigationKey(key: string) {
  return [
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "Home",
    "End",
    "PageUp",
    "PageDown",
  ].includes(key);
}

/** Keyboard geometry only; authoritative selection and seek writes are debounced separately. */
export function useWaveformKeyboard(options: KeyboardOptions) {
  const caret = useRef<Caret | undefined>(undefined);
  const { info, session, cancel } = options;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Caret geometry belongs to the current document/client session.
  useLayoutEffect(() => {
    caret.current = undefined;
  }, [info, session]);

  const blocked = (event: KeyboardEvent<HTMLElement>) =>
    options.disabled ||
    options.interacting ||
    (options.hasPreview() && !options.ownsPreview()) ||
    event.defaultPrevented ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.nativeEvent.isComposing;

  const apply = (range: SelectionRange, frame: number, forceSeek = false) => {
    const current = options.getSelection();
    if (equalRange(range, current) && !forceSeek) return;
    options.interrupt();
    options.change(range, frame);
    options.reveal(frame);
  };
  const onSurfaceKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      event.target !== event.currentTarget ||
      blocked(event) ||
      !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const current = options.getSelection();
    const previous = caret.current;
    const continuing = previous && equalRange(previous.selection, current);
    const backwards = event.key === "ArrowLeft" || event.key === "Home";
    const anchor = continuing ? previous.anchor : backwards ? current.end : current.start;
    const active = continuing ? previous.frame : backwards ? current.start : current.end;
    const frame =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? info.frames
          : !event.shiftKey && current.end > current.start
            ? backwards
              ? current.start
              : current.end
            : Math.max(0, Math.min(info.frames, active + (backwards ? -1 : 1)));
    const fixed = event.shiftKey ? anchor : frame;
    const range = {
      start: Math.min(fixed, frame),
      end: Math.max(fixed, frame),
      channelMask: current.channelMask,
    };
    caret.current = { anchor: fixed, frame, selection: range };
    apply(range, frame, event.key === "Home" || event.key === "End");
  };
  const onEdgeKeyDown = (event: KeyboardEvent<HTMLElement>, edge: Edge) => {
    if (blocked(event) || !navigationKey(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    caret.current = undefined;
    const current = options.getSelection();
    const backwards = ["ArrowLeft", "ArrowDown", "PageDown"].includes(event.key);
    // Arrows: 1 frame (Shift: 10). Pages: 1 second (Shift: 10 seconds).
    const step =
      (event.key.startsWith("Page") ? Math.max(1, Math.round(info.sampleRate)) : 1) *
      (event.shiftKey ? 10 : 1);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? info.frames
          : current[edge] + (backwards ? -step : step);
    const frame = Math.max(
      edge === "start" ? 0 : current.start,
      Math.min(edge === "start" ? current.end : info.frames, next),
    );
    apply({ ...current, [edge]: frame }, frame, event.key === "Home" || event.key === "End");
  };
  const onKeyUp = (event: KeyboardEvent<HTMLElement>) => {
    if (navigationKey(event.key)) options.flush();
  };
  const reset = useCallback(() => {
    caret.current = undefined;
    cancel();
  }, [cancel]);
  return {
    onSurfaceKeyDown,
    onEdgeKeyDown,
    onKeyUp,
    onBlur: options.flush,
    reset,
    beforePointer: () => {
      options.flush();
      caret.current = undefined;
      cancel();
    },
  };
}
