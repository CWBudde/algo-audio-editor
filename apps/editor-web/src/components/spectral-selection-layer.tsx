import type { SpectralPoint } from "@aae/protocol";
import { type PointerEvent, useLayoutEffect, useRef, useState } from "react";
import {
  type SpectralSelection,
  type SpectralTool,
  spectralMask,
  spectralPoint,
} from "@/lib/spectral-selection";

interface Props {
  documentId: string;
  frames: number;
  sampleRate: number;
  channel: number;
  viewport: { start: number; end: number };
  width: number;
  height: number;
  tool: SpectralTool;
  selection?: SpectralSelection;
  disabled: boolean;
  onChange(selection: SpectralSelection | undefined): void;
}
export function SpectralSelectionLayer({
  documentId,
  frames,
  sampleRate,
  channel,
  viewport,
  width,
  height,
  tool,
  selection,
  disabled,
  onChange,
}: Props) {
  const drag = useRef<
    | { id: number; signature: string; tool: "rectangle" | "lasso"; points: SpectralPoint[] }
    | undefined
  >(undefined);
  const [draft, setDraft] = useState<SpectralPoint[]>();
  const signature = JSON.stringify([
    documentId,
    frames,
    sampleRate,
    viewport.start,
    viewport.end,
    width,
    height,
    tool,
    disabled,
  ]);
  useLayoutEffect(() => {
    if (drag.current && drag.current.signature !== signature) {
      drag.current = undefined;
      setDraft(undefined);
    }
  }, [signature]);
  const point = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return spectralPoint(
      event.clientX - rect.left,
      event.clientY - rect.top,
      rect.width,
      rect.height,
      viewport,
      frames,
      sampleRate,
    );
  };
  const cancel = (event: PointerEvent<SVGSVGElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = undefined;
    setDraft(undefined);
  };
  const current =
    selection?.documentId === documentId && (selection.channelMask & (1 << channel)) !== 0
      ? selection.mask
      : undefined;
  const mask = draft && tool !== "time" ? spectralMask(draft, tool, frames) : current;
  const vertices =
    mask?.points ??
    (mask
      ? [
          { frame: mask.start, hz: mask.lowHz },
          { frame: mask.end, hz: mask.lowHz },
          { frame: mask.end, hz: mask.highHz },
          { frame: mask.start, hz: mask.highHz },
        ]
      : []);
  return (
    <svg
      role="application"
      aria-label={`Channel ${channel + 1} spectral selection`}
      tabIndex={tool === "time" ? -1 : 0}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      data-testid={`spectral-selection-${channel}`}
      data-start-frame={mask?.start}
      data-end-frame={mask?.end}
      data-low-hz={mask?.lowHz}
      data-high-hz={mask?.highHz}
      className={`absolute inset-0 h-full w-full touch-none ${tool === "time" || disabled ? "pointer-events-none" : "cursor-crosshair"}`}
      onPointerDown={(event) => {
        if (disabled || tool === "time" || event.button !== 0 || !event.isPrimary || drag.current)
          return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, signature, tool, points: [point(event)] };
        setDraft(drag.current.points);
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        if (!active || active.id !== event.pointerId || disabled || active.tool !== tool) return;
        const p = point(event);
        if (tool === "rectangle") active.points = [active.points[0] ?? p, p];
        else {
          if (active.points.length >= 128)
            active.points = active.points.filter((_, i) => i % 2 === 0);
          active.points = [...active.points, p];
        }
        setDraft(active.points);
      }}
      onPointerUp={(event) => {
        const active = drag.current;
        if (!active || active.id !== event.pointerId) return;
        drag.current = undefined;
        setDraft(undefined);
        if (disabled || active.tool !== tool) return;
        const p = point(event),
          points =
            active.tool === "rectangle"
              ? [active.points[0] ?? p, p]
              : [...active.points.slice(0, 127), p];
        const mask = spectralMask(points, active.tool, frames);
        if (mask) onChange({ documentId, channelMask: 1 << channel, mask });
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !disabled) {
          event.preventDefault();
          drag.current = undefined;
          setDraft(undefined);
          onChange(undefined);
        }
      }}
    >
      <title>Drag to select time and frequency. Escape clears the selection.</title>
      {vertices.length > 0 && (
        <polygon
          points={vertices
            .map(
              (p) =>
                `${((p.frame - viewport.start) / (viewport.end - viewport.start)) * width},${(1 - p.hz / (sampleRate / 2)) * height}`,
            )
            .join(" ")}
          className="fill-selection-fill stroke-selection"
          strokeWidth="1.5"
        />
      )}
    </svg>
  );
}
