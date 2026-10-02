import type { DocumentInfoResult } from "@aae/protocol";
import {
  type PointerEvent,
  type Ref,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { usePeaks } from "@/hooks/use-peaks";
import type { KernelClient } from "@/kernel/client";
import type { PeakViews } from "@/kernel/peak-data";
import { drawWaveform, resizeCanvas } from "@/lib/waveform-drawing";
import {
  type AmplitudeScale,
  clampViewport,
  type FrameRange,
  frameToX,
  generateAmplitudeTicks,
  generateTimeTicks,
  panViewport,
  type TimeFormat,
  xToFrame,
  zoomViewport,
} from "@/lib/waveform-geometry";

const RULER_WIDTH = 56;
const LANE_HEIGHT = 160;
const OVERVIEW_HEIGHT = 48;
const MAX_SCROLL_WIDTH = 1_000_000;

export interface WaveformViewHandle {
  zoomIn(): void;
  zoomOut(): void;
  zoomFit(): void;
  zoomSelection(): void;
}

interface WaveformViewProps {
  client: KernelClient | undefined;
  info: DocumentInfoResult;
  ref?: Ref<WaveformViewHandle>;
}

interface ViewState {
  document: DocumentInfoResult;
  viewport: FrameRange;
  selection: FrameRange | undefined;
}

/** CSS geometry and backing-store resolution are tracked independently. */
function useViewSize(tracks: RefObject<HTMLDivElement | null>) {
  const host = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(1);
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);

  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => {
      setWidth(Math.max(1, tracks.current?.clientWidth || element.getBoundingClientRect().width));
      setDpr(window.devicePixelRatio || 1);
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    if (tracks.current) observer?.observe(tracks.current);
    const resolution = window.matchMedia?.(`(resolution: ${dpr}dppx)`);
    resolution?.addEventListener("change", measure);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      resolution?.removeEventListener("change", measure);
      window.removeEventListener("resize", measure);
    };
  }, [dpr, tracks]);

  return { host, width: Math.max(1, width - RULER_WIDTH), dpr };
}

interface PeakCanvasProps {
  client: KernelClient | undefined;
  info: DocumentInfoResult;
  channel: number;
  viewport: FrameRange;
  width: number;
  height: number;
  dpr: number;
  overview?: boolean;
  onPointerDown?: (event: PointerEvent<HTMLCanvasElement>) => void;
  onPointerMove?: (event: PointerEvent<HTMLCanvasElement>) => void;
  onPointerUp?: (event: PointerEvent<HTMLCanvasElement>) => void;
  onPointerCancel?: (event: PointerEvent<HTMLCanvasElement>) => void;
  onLostPointerCapture?: (event: PointerEvent<HTMLCanvasElement>) => void;
}

function PeakCanvas({
  client,
  info,
  channel,
  viewport,
  width,
  height,
  dpr,
  overview = false,
  ...events
}: PeakCanvasProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { data, loading, error } = usePeaks(
    client,
    info,
    info.frames > 0
      ? {
          channel,
          startFrame: viewport.start,
          endFrame: viewport.end,
          buckets: Math.max(1, Math.min(8192, Math.ceil(width * dpr))),
        }
      : undefined,
  );
  const [paint, setPaint] = useState<{
    data: PeakViews;
    start: number;
    end: number;
    width: number;
    dpr: number;
  }>();

  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const context = resizeCanvas(element, width, height, dpr);
    if (!context) return;
    drawWaveform(context, data ?? null, viewport, width, height, { showRMS: !overview });
    if (data) setPaint({ data, start: viewport.start, end: viewport.end, width, dpr });
  }, [data, viewport, width, height, dpr, overview]);

  const rendered = Boolean(
    data &&
      paint?.data === data &&
      paint.start === viewport.start &&
      paint.end === viewport.end &&
      paint.width === width &&
      paint.dpr === dpr,
  );

  return (
    <>
      <canvas
        ref={canvas}
        className="block w-full touch-none"
        style={{ height }}
        role="img"
        aria-label={
          overview ? "Full document waveform overview" : `Channel ${channel + 1} waveform`
        }
        aria-busy={loading}
        data-testid={overview ? "waveform-overview" : `waveform-channel-${channel}`}
        data-rendered={String(rendered)}
        {...events}
      >
        {overview ? "Document overview" : `Channel ${channel + 1} waveform`}
      </canvas>
      {error && (
        <p role="alert" className="absolute left-2 top-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </>
  );
}

export function WaveformView({ client, info, ref }: WaveformViewProps) {
  const fullRange = useMemo(() => ({ start: 0, end: info.frames }), [info]);
  const [state, setState] = useState<ViewState>({
    document: info,
    viewport: fullRange,
    selection: undefined,
  });
  const current =
    state.document === info ? state : { document: info, viewport: fullRange, selection: undefined };
  const { viewport, selection } = current;
  const lanes = useRef<HTMLDivElement>(null);
  const lanesId = useId();
  const { host, width, dpr } = useViewSize(lanes);
  const [timeFormat, setTimeFormat] = useState<TimeFormat>("seconds");
  const [amplitudeScale, setAmplitudeScale] = useState<AmplitudeScale>("linear");
  const scrollbar = useRef<HTMLDivElement>(null);
  const currentViewport = useRef(viewport);
  currentViewport.current = viewport;
  const selectionDrag = useRef<{ pointer: number; anchor: number } | undefined>(undefined);
  const overviewDrag = useRef<{ pointer: number; x: number; viewport: FrameRange } | undefined>(
    undefined,
  );
  const pendingScroll = useRef<number | undefined>(undefined);

  useEffect(() => {
    setState({ document: info, viewport: fullRange, selection: undefined });
    selectionDrag.current = undefined;
    overviewDrag.current = undefined;
  }, [info, fullRange]);

  const updateViewport = useCallback(
    (change: (range: FrameRange) => FrameRange) => {
      setState((previous) => {
        const base =
          previous.document === info
            ? previous
            : { document: info, viewport: fullRange, selection: undefined };
        return { ...base, viewport: clampViewport(change(base.viewport), info.frames) };
      });
    },
    [info, fullRange],
  );

  const setSelection = useCallback(
    (range: FrameRange) => {
      setState((previous) => {
        const base =
          previous.document === info
            ? previous
            : { document: info, viewport: fullRange, selection: undefined };
        return { ...base, selection: range };
      });
    },
    [info, fullRange],
  );

  const zoomIn = useCallback(
    () => updateViewport((range) => zoomViewport(range, info.frames, 2)),
    [info.frames, updateViewport],
  );
  const zoomOut = useCallback(
    () => updateViewport((range) => zoomViewport(range, info.frames, 0.5)),
    [info.frames, updateViewport],
  );
  const zoomFit = useCallback(() => updateViewport(() => fullRange), [fullRange, updateViewport]);
  const zoomSelection = useCallback(() => {
    if (selection && selection.end > selection.start) updateViewport(() => selection);
  }, [selection, updateViewport]);
  useImperativeHandle(ref, () => ({ zoomIn, zoomOut, zoomFit, zoomSelection }), [
    zoomIn,
    zoomOut,
    zoomFit,
    zoomSelection,
  ]);

  useEffect(() => {
    const element = lanes.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? width : 1;
      if (event.ctrlKey) {
        event.preventDefault();
        const bounds = element.getBoundingClientRect();
        const anchor = Math.max(
          0,
          Math.min(1, (event.clientX - bounds.left - RULER_WIDTH) / width),
        );
        const factor = Math.max(0.125, Math.min(8, Math.exp(-event.deltaY * unit * 0.003)));
        updateViewport((range) => zoomViewport(range, info.frames, factor, anchor));
      } else if (event.shiftKey || event.deltaX !== 0) {
        event.preventDefault();
        const pixels = (event.deltaX || event.deltaY) * unit;
        updateViewport((range) =>
          panViewport(range, info.frames, (pixels / width) * (range.end - range.start)),
        );
      }
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [info.frames, updateViewport, width]);

  const span = viewport.end - viewport.start;
  const maxStart = Math.max(0, info.frames - span);
  const scrollWidth = Math.max(
    width,
    Math.min(MAX_SCROLL_WIDTH, span > 0 ? (width * info.frames) / span : width),
  );
  useLayoutEffect(() => {
    const element = scrollbar.current;
    if (!element) return;
    element.scrollLeft =
      maxStart > 0 ? (viewport.start / maxStart) * Math.max(0, scrollWidth - width) : 0;
    pendingScroll.current = element.scrollLeft;
  }, [viewport.start, maxStart, scrollWidth, width]);

  const pointerFrame = (event: PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return Math.round(
      xToFrame(
        Math.max(0, Math.min(width, event.clientX - bounds.left)),
        currentViewport.current,
        width,
      ),
    );
  };
  const startSelection = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || info.frames === 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const anchor = pointerFrame(event);
    selectionDrag.current = { pointer: event.pointerId, anchor };
    setSelection({ start: anchor, end: anchor });
  };
  const moveSelection = (event: PointerEvent<HTMLCanvasElement>) => {
    const drag = selectionDrag.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    const frame = pointerFrame(event);
    setSelection({ start: Math.min(drag.anchor, frame), end: Math.max(drag.anchor, frame) });
  };
  const endSelection = (event: PointerEvent<HTMLCanvasElement>) => {
    moveSelection(event);
    selectionDrag.current = undefined;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const timeTicks = generateTimeTicks(viewport, width, info.sampleRate, timeFormat);
  const amplitudeTicks = generateAmplitudeTicks(LANE_HEIGHT, amplitudeScale);
  const selectionStart = selection ? Math.max(viewport.start, selection.start) : 0;
  const selectionEnd = selection ? Math.min(viewport.end, selection.end) : 0;
  const overviewLeft = info.frames > 0 ? (viewport.start / info.frames) * width : 0;
  const overviewWidth = info.frames > 0 ? (span / info.frames) * width : width;
  const sharedColumns = {
    gridTemplateColumns: `${RULER_WIDTH}px minmax(0, 1fr)`,
    width: RULER_WIDTH + width,
  };
  const channelIds = useMemo(
    () => Array.from({ length: info.channels }, (_, channel) => channel),
    [info.channels],
  );

  return (
    <section
      ref={host}
      className="flex h-full min-h-[24rem] min-w-0 flex-col"
      data-testid="waveform-view"
      data-start-frame={viewport.start}
      data-end-frame={viewport.end}
    >
      <header className="border-b px-3 py-2" data-testid="document-info">
        <h1
          className="truncate text-sm font-semibold"
          data-testid="document-name"
          title={info.name}
        >
          {info.name}
        </h1>
        <p className="text-xs tabular-nums" data-testid="document-details">
          {info.sampleRate} Hz · {info.channels} {info.channels === 1 ? "channel" : "channels"} ·{" "}
          {info.frames} frames · {(info.frames / info.sampleRate).toFixed(3)} s · {info.bitDepth}
          -bit {info.float ? "float" : "PCM"}
        </p>
        <p className="text-xs text-muted-foreground">
          Test tone playback is independent of this document.
        </p>
      </header>
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5">
        <Button
          size="xs"
          variant="outline"
          onClick={zoomIn}
          disabled={info.frames === 0 || span <= 1}
        >
          Zoom in
        </Button>
        <Button size="xs" variant="outline" onClick={zoomOut} disabled={span >= info.frames}>
          Zoom out
        </Button>
        <Button size="xs" variant="outline" onClick={zoomFit} disabled={info.frames === 0}>
          Zoom to fit
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={zoomSelection}
          disabled={!selection || selection.end <= selection.start}
        >
          Zoom to selection
        </Button>
        <label className="flex items-center gap-1 text-xs">
          Time format
          <select
            aria-label="Time format"
            className="rounded border bg-background p-1"
            value={timeFormat}
            onChange={(event) => setTimeFormat(event.target.value as TimeFormat)}
          >
            <option value="samples">Samples</option>
            <option value="seconds">Seconds</option>
            <option value="hms">Hours:minutes:seconds</option>
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs">
          Amplitude scale
          <select
            aria-label="Amplitude scale"
            className="rounded border bg-background p-1"
            value={amplitudeScale}
            onChange={(event) => setAmplitudeScale(event.target.value as AmplitudeScale)}
          >
            <option value="linear">Linear</option>
            <option value="db">dB</option>
          </select>
        </label>
        <span className="ml-auto text-xs text-muted-foreground">Peak / RMS</span>
      </div>
      <div className="grid border-b" style={sharedColumns}>
        <span className="flex items-center justify-center text-[10px] text-muted-foreground">
          Time
        </span>
        <div className="relative h-7 overflow-hidden" data-testid="waveform-time-ruler">
          {timeTicks.map((tick) => (
            <span
              key={tick.frame}
              className="absolute top-0 h-full border-l border-border"
              style={{ left: tick.x }}
            >
              <span className="absolute left-1 top-1 whitespace-nowrap text-[10px] tabular-nums">
                {tick.label}
              </span>
            </span>
          ))}
        </div>
      </div>
      <div
        ref={lanes}
        id={lanesId}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        style={{ scrollbarGutter: "stable" }}
      >
        {info.frames === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            No audio frames in this document.
          </p>
        ) : (
          channelIds.map((channel) => (
            <div key={channel} className="border-b">
              <div className="bg-muted/30 px-3 py-1 text-xs text-muted-foreground">
                Channel {channel + 1}
              </div>
              <div
                className="grid"
                style={{ gridTemplateColumns: `${RULER_WIDTH}px minmax(0, 1fr)` }}
              >
                <div
                  className="relative border-r"
                  style={{ height: LANE_HEIGHT }}
                  data-testid={`waveform-amplitude-ruler-${channel}`}
                >
                  {amplitudeTicks.map((tick) => (
                    <span
                      key={tick.value}
                      className="absolute right-1 -translate-y-1/2 text-[10px] tabular-nums text-muted-foreground"
                      style={{ top: Math.max(7, Math.min(LANE_HEIGHT - 7, tick.y)) }}
                    >
                      {tick.label}
                    </span>
                  ))}
                </div>
                <div className="relative min-w-0 overflow-hidden">
                  <PeakCanvas
                    client={client}
                    info={info}
                    channel={channel}
                    viewport={viewport}
                    width={width}
                    height={LANE_HEIGHT}
                    dpr={dpr}
                    onPointerDown={startSelection}
                    onPointerMove={moveSelection}
                    onPointerUp={endSelection}
                    onPointerCancel={() => {
                      selectionDrag.current = undefined;
                    }}
                    onLostPointerCapture={() => {
                      selectionDrag.current = undefined;
                    }}
                  />
                  {selection && selectionEnd >= selectionStart && (
                    <div
                      aria-hidden="true"
                      data-testid={
                        channel === 0 ? "waveform-selection" : `waveform-selection-${channel}`
                      }
                      className="pointer-events-none absolute inset-y-0 border border-blue-400 bg-blue-400/15"
                      style={{
                        left: frameToX(selectionStart, viewport, width),
                        width: Math.max(
                          1,
                          frameToX(selectionEnd, viewport, width) -
                            frameToX(selectionStart, viewport, width),
                        ),
                      }}
                    />
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="grid border-t" style={sharedColumns}>
        <span className="flex items-center justify-center text-[10px] text-muted-foreground">
          Overview
        </span>
        <div
          className="relative min-w-0 touch-none overflow-hidden"
          onPointerDown={(event) => {
            if (event.button !== 0 || info.frames === 0) return;
            event.currentTarget.setPointerCapture?.(event.pointerId);
            const bounds = event.currentTarget.getBoundingClientRect();
            let base = currentViewport.current;
            if (
              !(
                event.target instanceof HTMLElement &&
                event.target.dataset.testid === "waveform-overview-viewport"
              )
            ) {
              const center = ((event.clientX - bounds.left) / width) * info.frames;
              base = clampViewport(
                { start: Math.round(center - span / 2), end: Math.round(center + span / 2) },
                info.frames,
              );
              updateViewport(() => base);
            }
            overviewDrag.current = { pointer: event.pointerId, x: event.clientX, viewport: base };
          }}
          onPointerMove={(event) => {
            const drag = overviewDrag.current;
            if (!drag || drag.pointer !== event.pointerId) return;
            updateViewport(() =>
              panViewport(
                drag.viewport,
                info.frames,
                ((event.clientX - drag.x) / width) * info.frames,
              ),
            );
          }}
          onPointerUp={(event) => {
            overviewDrag.current = undefined;
            if (event.currentTarget.hasPointerCapture?.(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            overviewDrag.current = undefined;
          }}
          onLostPointerCapture={() => {
            overviewDrag.current = undefined;
          }}
        >
          <PeakCanvas
            client={client}
            info={info}
            channel={0}
            viewport={fullRange}
            width={width}
            height={OVERVIEW_HEIGHT}
            dpr={dpr}
            overview
          />
          <div
            data-testid="waveform-overview-viewport"
            className="absolute inset-y-0 cursor-grab border-2 border-blue-400 bg-blue-400/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            style={{ left: overviewLeft, width: Math.max(2, overviewWidth) }}
            role="slider"
            aria-label="Visible time range"
            aria-valuemin={0}
            aria-valuemax={maxStart}
            aria-valuenow={viewport.start}
            aria-disabled={info.frames === 0}
            tabIndex={info.frames > 0 ? 0 : -1}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                updateViewport((range) =>
                  panViewport(
                    range,
                    info.frames,
                    Math.max(1, span / 10) * (event.key === "ArrowLeft" ? -1 : 1),
                  ),
                );
              } else if (event.key === "Home" || event.key === "End") {
                event.preventDefault();
                updateViewport(() => ({
                  start: event.key === "Home" ? 0 : maxStart,
                  end: (event.key === "Home" ? 0 : maxStart) + span,
                }));
              }
            }}
          />
        </div>
      </div>
      <div className="grid" style={sharedColumns}>
        <span />
        <div
          ref={scrollbar}
          data-testid="waveform-scrollbar"
          role="scrollbar"
          aria-label="Horizontal waveform scroll"
          aria-orientation="horizontal"
          aria-controls={lanesId}
          aria-valuemin={0}
          aria-valuemax={maxStart}
          aria-valuenow={viewport.start}
          tabIndex={0}
          className="h-5 min-w-0 overflow-x-scroll overflow-y-hidden"
          onScroll={(event) => {
            const element = event.currentTarget;
            if (
              pendingScroll.current !== undefined &&
              Math.abs(element.scrollLeft - pendingScroll.current) < 1
            ) {
              pendingScroll.current = undefined;
              return;
            }
            pendingScroll.current = undefined;
            const extent = element.scrollWidth - element.clientWidth;
            if (extent <= 0) return;
            const start = Math.round((element.scrollLeft / extent) * maxStart);
            updateViewport(() => ({ start, end: start + span }));
          }}
        >
          <div className="h-px" style={{ width: scrollWidth }} />
        </div>
      </div>
    </section>
  );
}
