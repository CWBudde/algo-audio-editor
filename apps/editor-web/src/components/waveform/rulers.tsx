import { useCallback, useLayoutEffect, useRef } from "react";
import {
  clampVerticalZoom,
  type FrameRange,
  type generateAmplitudeTicks,
  generateTimeSubTicks,
  type generateTimeTicks,
  type TimeFormat,
} from "@/lib/waveform-geometry";

export function TimeRuler({
  ticks: timeTicks,
  range,
  width,
  sampleRate,
  format,
}: {
  ticks: ReturnType<typeof generateTimeTicks>;
  range: FrameRange;
  width: number;
  sampleRate: number;
  format: TimeFormat;
}) {
  const subTicks = generateTimeSubTicks(range, width, sampleRate, format);
  return (
    <>
      {subTicks.map((tick) => (
        <span
          key={tick.frame}
          aria-hidden="true"
          data-time-tick={tick.kind}
          className={`absolute bottom-0 border-l border-muted-foreground/60 ${tick.kind === "medium" ? "h-2" : "h-1"}`}
          style={{ left: tick.x }}
        />
      ))}
      {timeTicks.map((tick) => (
        <span
          key={tick.frame}
          data-time-tick="major"
          className="waveform-time-tick absolute inset-y-0"
          style={{ left: tick.x }}
        >
          <span
            aria-hidden="true"
            className="absolute bottom-0 left-0 h-2.5 border-l border-muted-foreground/70"
          />
          {tick.x + tick.label.length * 3.3 <= width && (
            <span className="absolute left-0 top-0 -translate-x-1/2 whitespace-nowrap font-mono text-[11px] tabular-nums text-muted-foreground">
              {tick.label}
            </span>
          )}
        </span>
      ))}
    </>
  );
}
export function AmplitudeRuler({
  ticks,
  height,
  channel,
  verticalZoom = 1,
  onZoomChange,
}: {
  ticks: ReturnType<typeof generateAmplitudeTicks>;
  height: number;
  channel: number;
  verticalZoom?: number;
  onZoomChange?: (zoom: number) => void;
}) {
  const ruler = useRef<HTMLDivElement>(null);
  const zoomValue = useRef(verticalZoom);
  zoomValue.current = verticalZoom;
  const applyZoom = useCallback(
    (zoom: number) => {
      zoomValue.current = clampVerticalZoom(zoom);
      onZoomChange?.(zoomValue.current);
    },
    [onZoomChange],
  );
  useLayoutEffect(() => {
    const element = ruler.current;
    if (!element || !onZoomChange) return;
    // React delegates wheel events passively; this ruler must consume its zoom gesture.
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.deltaY !== 0) applyZoom(zoomValue.current * (event.deltaY < 0 ? 2 : 0.5));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [applyZoom, onZoomChange]);
  const labels = ticks.map((tick) => (
    <span
      key={tick.value}
      className="absolute right-2 -translate-y-1/2 font-mono text-[10px] tabular-nums text-muted-foreground"
      style={{ top: Math.max(7, Math.min(height - 7, tick.y)) }}
    >
      {tick.label}
    </span>
  ));
  if (!onZoomChange)
    return (
      <div
        ref={ruler}
        className="waveform-amplitude-ruler relative border-r"
        style={{ height }}
        data-testid={`waveform-amplitude-ruler-${channel}`}
      >
        {labels}
      </div>
    );
  return (
    <div
      ref={ruler}
      className="waveform-amplitude-ruler relative border-r focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      style={{ height }}
      data-testid={`waveform-amplitude-ruler-${channel}`}
      role="slider"
      aria-label={`Channel ${channel + 1} vertical zoom`}
      aria-valuemin={1}
      aria-valuemax={64}
      aria-valuenow={verticalZoom}
      aria-valuetext={`${verticalZoom}×; full scale ±${1 / verticalZoom}`}
      aria-orientation="vertical"
      tabIndex={0}
      title="Vertical zoom: scroll or press + / −. Home or double-click resets to 1×; End selects 64×."
      onDoubleClick={() => applyZoom(1)}
      onKeyDown={(event) => {
        const factor = ["+", "=", "ArrowUp", "ArrowRight"].includes(event.key)
          ? 2
          : ["-", "_", "ArrowDown", "ArrowLeft"].includes(event.key)
            ? 0.5
            : undefined;
        if (factor || event.key === "Home" || event.key === "End") {
          event.preventDefault();
          event.stopPropagation();
          applyZoom(
            event.key === "Home" ? 1 : event.key === "End" ? 64 : zoomValue.current * (factor ?? 1),
          );
        }
      }}
    >
      {labels}
    </div>
  );
}
