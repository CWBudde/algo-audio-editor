import { type PointerEvent, useLayoutEffect, useRef, useState } from "react";
import { type FrameRange, panViewport, zoomViewport } from "@/lib/waveform-geometry";

interface RulerNavigationOptions {
  session: unknown;
  disabled: boolean;
  viewport: FrameRange;
  totalFrames: number;
  width: number;
  onNavigate(): void;
  updateViewport(change: (range: FrameRange) => FrameRange): void;
}

/** Ruler dragging and wheel zoom navigate the view without seeking or selecting. */
export function useRulerNavigation(options: RulerNavigationOptions) {
  const ruler = useRef<HTMLDivElement>(null);
  const drag = useRef<
    | {
        pointer: number;
        origin: number;
        width: number;
        viewport: FrameRange;
        totalFrames: number;
        anchor: number;
        zoom: boolean;
        delta: number;
      }
    | undefined
  >(undefined);
  const animation = useRef<number | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const latest = useRef(options);
  latest.current = options;
  useLayoutEffect(() => {
    const element = ruler.current;
    if (!element) return;
    // React's delegated wheel events are passive; this surface owns wheel zoom.
    const wheel = (event: WheelEvent) => {
      const current = latest.current;
      const delta = event.deltaY || event.deltaX;
      if (current.disabled || delta === 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (drag.current) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? current.width : 1;
      const anchor = Math.max(
        0,
        Math.min(1, (event.clientX - element.getBoundingClientRect().left) / current.width),
      );
      const factor = Math.max(0.125, Math.min(8, Math.exp(-delta * unit * 0.003)));
      current.onNavigate();
      current.updateViewport((range) => zoomViewport(range, current.totalFrames, factor, anchor));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A replaced session or disabled ruler abandons the active drag and its pending frame.
  useLayoutEffect(() => {
    drag.current = undefined;
    setDragging(false);
    return () => {
      drag.current = undefined;
      if (animation.current !== undefined) cancelAnimationFrame(animation.current);
      animation.current = undefined;
    };
  }, [options.session, options.disabled]);
  const apply = () => {
    const active = drag.current;
    if (!active) return;
    const next = active.zoom
      ? zoomViewport(active.viewport, active.totalFrames, 2 ** (active.delta / 160), active.anchor)
      : panViewport(
          active.viewport,
          active.totalFrames,
          (-active.delta / active.width) * (active.viewport.end - active.viewport.start),
        );
    latest.current.updateViewport(() => next);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || active.pointer !== event.pointerId) return;
    active.delta = event.clientX - active.origin;
    if (animation.current !== undefined) return;
    animation.current = requestAnimationFrame(() => {
      animation.current = undefined;
      apply();
    });
  };
  const finish = (event: PointerEvent<HTMLDivElement>, usePointer: boolean) => {
    const active = drag.current;
    if (!active || active.pointer !== event.pointerId) return;
    if (animation.current !== undefined) cancelAnimationFrame(animation.current);
    animation.current = undefined;
    if (usePointer) {
      active.delta = event.clientX - active.origin;
      apply();
    }
    drag.current = undefined;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return {
    ref: ruler,
    active: drag,
    dragging,
    onPointerDown(event: PointerEvent<HTMLDivElement>) {
      if (
        options.disabled ||
        event.button !== 0 ||
        drag.current ||
        (event.target instanceof Element && event.target.closest("button"))
      )
        return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      options.onNavigate();
      drag.current = {
        pointer: event.pointerId,
        origin: event.clientX,
        width: options.width,
        viewport: options.viewport,
        totalFrames: options.totalFrames,
        anchor: Math.max(
          0,
          Math.min(
            1,
            (event.clientX - event.currentTarget.getBoundingClientRect().left) / options.width,
          ),
        ),
        zoom: options.viewport.end - options.viewport.start >= options.totalFrames,
        delta: 0,
      };
      setDragging(true);
    },
    onPointerMove: move,
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => finish(event, true),
    onPointerCancel: (event: PointerEvent<HTMLDivElement>) => finish(event, false),
    onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => finish(event, false),
  };
}
