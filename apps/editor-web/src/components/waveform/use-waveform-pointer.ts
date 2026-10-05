import type { DocumentInfoResult, SelectionRange } from "@aae/protocol";
import { type MouseEvent, type PointerEvent, useCallback, useLayoutEffect, useRef } from "react";
import type { useSelection } from "@/hooks/use-selection";
import type { KernelClient } from "@/kernel/client";
import { snapSelectionFrame } from "@/lib/selection";
import {
  type FrameRange,
  generateTimeTicks,
  type TimeFormat,
  xToFrame,
} from "@/lib/waveform-geometry";

interface PointerOptions {
  client: KernelClient | undefined;
  info: DocumentInfoResult;
  editor: ReturnType<typeof useSelection>;
  disabled: boolean;
  width: number;
  viewport: FrameRange;
  onSeek?: (frame: number) => void;
  snapZero: boolean;
  snapMarkers: boolean;
  snapTicks: boolean;
  timeFormat: TimeFormat;
}
export function useWaveformPointer({
  client,
  info,
  editor,
  disabled,
  width,
  viewport,
  onSeek,
  snapZero,
  snapMarkers,
  snapTicks,
  timeFormat,
}: PointerOptions) {
  const { selection, timeline } = editor;
  const selectionDrag = useRef<
    | {
        pointer: number;
        anchor: number;
        rawAnchor: number;
        snapAnchor: boolean;
        offset: number;
        previous: SelectionRange;
      }
    | undefined
  >(undefined);
  const interaction = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Document and client replacement invalidate pending snap replies.
  useLayoutEffect(() => {
    // A new selection session (including client replacement) or import lock
    // invalidates any pending zero-snap completion before it can seek.
    interaction.current++;
    selectionDrag.current = undefined;
    if (disabled) {
      editor.cancelPreview();
    }
  }, [disabled, editor.cancelPreview, client, info]);

  const setSelection = useCallback(
    (range: SelectionRange) => {
      if (disabled) return;
      interaction.current++;
      selectionDrag.current = undefined;
      editor.commit(range);
      if (range.start !== selection.start || range.end !== selection.end) onSeek?.(range.start);
    },
    [disabled, editor.commit, onSeek, selection.start, selection.end],
  );
  const pointerFrame = (event: { currentTarget: HTMLElement; clientX: number }) => {
    const target = event.currentTarget;
    const track = target instanceof HTMLCanvasElement ? target : target.parentElement;
    const bounds = (track ?? target).getBoundingClientRect();
    return Math.round(
      xToFrame(Math.max(0, Math.min(width, event.clientX - bounds.left)), viewport, width),
    );
  };
  const timeTicks = generateTimeTicks(viewport, width, info.sampleRate, timeFormat);
  const snapRadius = Math.max(0, Math.round((6 / width) * (viewport.end - viewport.start)));
  const snapCandidates = [
    ...(snapMarkers
      ? [
          ...timeline.markers.map((marker) => marker.frame),
          ...timeline.regions.flatMap((region) => [region.start, region.end]),
        ]
      : []),
    ...(snapTicks ? timeTicks.map((tick) => tick.frame) : []),
  ];
  const snapFrame = (frame: number, zero?: number) =>
    snapSelectionFrame(
      frame,
      zero === undefined ? snapCandidates : [...snapCandidates, zero],
      snapRadius,
      info.frames,
    );
  const startSelection = (event: PointerEvent<HTMLElement>, edge?: "start" | "end") => {
    if (disabled || event.button !== 0 || info.frames === 0) return;
    interaction.current++;
    const current = editor.getSelection();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const rawFrame = pointerFrame(event);
    const frame = snapFrame(rawFrame);
    const extending = event.shiftKey;
    const fixed =
      edge === "start"
        ? current.end
        : edge === "end"
          ? current.start
          : extending
            ? frame < current.start + (current.end - current.start) / 2
              ? current.end
              : current.start
            : frame;
    selectionDrag.current = {
      pointer: event.pointerId,
      anchor: fixed,
      rawAnchor: edge || extending ? fixed : rawFrame,
      snapAnchor: !edge && !extending,
      offset: edge ? rawFrame - current[edge] : 0,
      previous: current,
    };
    const moving = edge ? current[edge] : frame;
    editor.preview({
      start: Math.min(fixed, moving),
      end: Math.max(fixed, moving),
      channelMask: current.channelMask,
    });
  };
  const moveSelection = (event: PointerEvent<HTMLElement>) => {
    const drag = selectionDrag.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    const frame = snapFrame(Math.max(0, Math.min(info.frames, pointerFrame(event) - drag.offset)));
    editor.preview({
      start: Math.min(drag.anchor, frame),
      end: Math.max(drag.anchor, frame),
      channelMask: drag.previous.channelMask,
    });
  };
  const endSelection = (event: PointerEvent<HTMLElement>) => {
    const drag = selectionDrag.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    moveSelection(event);
    const rawFrame = Math.max(0, Math.min(info.frames, pointerFrame(event) - drag.offset));
    const sequence = interaction.current;
    selectionDrag.current = undefined;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    const finish = (anchor: number, frame: number) => {
      if (interaction.current !== sequence) return;
      const range = {
        start: Math.min(anchor, frame),
        end: Math.max(anchor, frame),
        channelMask: drag.previous.channelMask,
      };
      editor.commit(range);
      onSeek?.(range.start);
    };
    if (!snapZero) {
      finish(drag.anchor, snapFrame(rawFrame));
      return;
    }
    // Keep zero-crossing work bounded even when viewing an hours-long file.
    const radius = Math.min(8192, snapRadius, Math.ceil(info.sampleRate * 0.02));
    void Promise.all([
      drag.snapAnchor ? editor.snap(drag.rawAnchor, radius, drag.previous.channelMask) : undefined,
      editor.snap(rawFrame, radius, drag.previous.channelMask),
    ]).then(([anchor, frame]) => {
      if (interaction.current !== sequence) return;
      if (!frame || (drag.snapAnchor && !anchor)) {
        // A failed analysis must not silently turn a requested snapped edit
        // into an unsnapped one. Keep the last committed selection and error.
        editor.cancelPreview();
        return;
      }
      finish(
        drag.snapAnchor
          ? snapFrame(drag.rawAnchor, anchor?.found ? anchor.frame : undefined)
          : drag.anchor,
        snapFrame(rawFrame, frame?.found ? frame.frame : undefined),
      );
    });
  };
  const cancelSelection = (event: PointerEvent<HTMLElement>) => {
    const drag = selectionDrag.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    selectionDrag.current = undefined;
    interaction.current++;
    editor.cancelPreview();
  };
  const selectRegion = (event: MouseEvent<HTMLElement>) => {
    if (disabled || info.frames === 0) return;
    const frame = Math.min(info.frames - 1, pointerFrame(event));
    const region = timeline.regions
      .filter((region) => frame >= region.start && frame < region.end)
      .sort((a, b) => a.end - a.start - (b.end - b.start) || a.id - b.id)[0];
    const boundaries = [0, ...timeline.markers.map((marker) => marker.frame), info.frames].sort(
      (a, b) => a - b,
    );
    const start = region?.start ?? boundaries.filter((boundary) => boundary <= frame).at(-1) ?? 0;
    const end = region?.end ?? boundaries.find((boundary) => boundary > frame) ?? info.frames;
    setSelection({ start, end, channelMask: selection.channelMask });
  };
  return {
    selectionDrag,
    interaction,
    setSelection,
    startSelection,
    moveSelection,
    endSelection,
    cancelSelection,
    selectRegion,
    timeTicks,
  };
}
