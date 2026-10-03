import type { DocumentInfoResult, SelectionRange } from "@aae/protocol";
import {
  type MouseEvent,
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
import { SelectionBar } from "@/components/selection-bar";
import type { PlaybackFollow } from "@/components/transport-bar";
import { Button } from "@/components/ui/button";
import { type PeaksState, usePeaks } from "@/hooks/use-peaks";
import { useSelection } from "@/hooks/use-selection";
import type { KernelClient } from "@/kernel/client";
import type { PeakViews } from "@/kernel/peak-data";
import { snapSelectionFrame } from "@/lib/selection";
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
  selection(): FrameRange | undefined;
  clearSelection(frame?: number): void;
  updatePlayback(frame: number): void;
}

interface WaveformViewProps {
  client: KernelClient | undefined;
  info: DocumentInfoResult;
  ref?: Ref<WaveformViewHandle>;
  position?: number;
  playing?: boolean;
  follow?: PlaybackFollow;
  onSeek?(frame: number): void;
  readPosition?(): number;
  disabled?: boolean;
}

interface ViewState {
  document: DocumentInfoResult;
  viewport: FrameRange;
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
  peaks?: PeaksState;
  onPointerDown?: (event: PointerEvent<HTMLCanvasElement>) => void;
  onPointerMove?: (event: PointerEvent<HTMLCanvasElement>) => void;
  onPointerUp?: (event: PointerEvent<HTMLCanvasElement>) => void;
  onPointerCancel?: (event: PointerEvent<HTMLCanvasElement>) => void;
  onLostPointerCapture?: (event: PointerEvent<HTMLCanvasElement>) => void;
  onDoubleClick?: (event: MouseEvent<HTMLCanvasElement>) => void;
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
  peaks,
  ...events
}: PeakCanvasProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const ownPeaks = usePeaks(
    client,
    info,
    !peaks && info.frames > 0
      ? {
          channel,
          startFrame: viewport.start,
          endFrame: viewport.end,
          buckets: Math.max(1, Math.min(8192, Math.ceil(width * dpr))),
        }
      : undefined,
  );
  const { data, loading, error } = peaks ?? ownPeaks;
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

export function WaveformView({
  client,
  info,
  ref,
  position = 0,
  playing = false,
  follow = "off",
  onSeek,
  readPosition,
  disabled = false,
}: WaveformViewProps) {
  const fullRange = useMemo(() => ({ start: 0, end: info.frames }), [info]);
  const [state, setState] = useState<ViewState>({
    document: info,
    viewport: fullRange,
  });
  const current = state.document === info ? state : { document: info, viewport: fullRange };
  const { viewport } = current;
  const editor = useSelection(client, info);
  const { selection, timeline } = editor;
  const selectedRange = selection.end > selection.start ? selection : undefined;
  const lanes = useRef<HTMLDivElement>(null);
  const cursorLines = useRef<(HTMLDivElement | null)[]>([]);
  const overviewCursor = useRef<HTMLDivElement>(null);
  const lanesId = useId();
  const { host, width, dpr } = useViewSize(lanes);
  // The overview and a fitted first lane draw the same kernel summaries.
  // Keep one bounded full-range result; zoomed lanes retain their own requests.
  const fullPeaks = usePeaks(
    client,
    info,
    info.frames > 0
      ? {
          channel: 0,
          startFrame: 0,
          endFrame: info.frames,
          buckets: Math.max(1, Math.min(8192, Math.ceil(width * dpr))),
        }
      : undefined,
  );
  const [timeFormat, setTimeFormat] = useState<TimeFormat>("seconds");
  const [amplitudeScale, setAmplitudeScale] = useState<AmplitudeScale>("linear");
  const scrollbar = useRef<HTMLDivElement>(null);
  const currentViewport = useRef(viewport);
  currentViewport.current = viewport;
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
  const [snapZero, setSnapZero] = useState(false);
  const [snapMarkers, setSnapMarkers] = useState(false);
  const [snapTicks, setSnapTicks] = useState(false);
  const [anchorName, setAnchorName] = useState("");
  const overviewDrag = useRef<{ pointer: number; x: number; viewport: FrameRange } | undefined>(
    undefined,
  );
  const pendingScroll = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    setState({ document: info, viewport: fullRange });
    interaction.current++;
    selectionDrag.current = undefined;
    overviewDrag.current = undefined;
  }, [info, fullRange]);

  useLayoutEffect(() => {
    // A new selection session (including client replacement) or import lock
    // invalidates any pending zero-snap completion before it can seek.
    interaction.current++;
    selectionDrag.current = undefined;
    if (disabled) {
      editor.cancelPreview();
    }
  }, [disabled, editor.cancelPreview]);

  const updateViewport = useCallback(
    (change: (range: FrameRange) => FrameRange) => {
      setState((previous) => {
        const base =
          previous.document === info ? previous : { document: info, viewport: fullRange };
        const next = clampViewport(change(base.viewport), info.frames);
        if (
          base === previous &&
          next.start === base.viewport.start &&
          next.end === base.viewport.end
        )
          return previous;
        return { ...base, viewport: next };
      });
    },
    [info, fullRange],
  );

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
  const paintPlayback = useCallback(
    (frame: number) => {
      const visible = frame >= viewport.start && frame <= viewport.end && info.frames > 0;
      const x = Math.min(width - 1, frameToX(frame, viewport, width));
      for (const line of cursorLines.current) {
        if (!line) continue;
        line.style.display = visible ? "" : "none";
        line.style.left = `${x}px`;
        line.setAttribute("data-frame", String(frame));
      }
      const overview = overviewCursor.current;
      if (overview && info.frames > 0) {
        overview.style.left = `${Math.min(width - 1, (frame / info.frames) * width)}px`;
        overview.dataset.frame = String(frame);
      }
    },
    [viewport, info.frames, width],
  );
  const followPlayback = useCallback(
    (frame: number) => {
      if (!playing || follow === "off" || info.frames === 0) return;
      updateViewport((range) => {
        const length = range.end - range.start;
        if (length >= info.frames) return range;
        if (follow === "page" && frame >= range.start && frame < range.end) return range;
        const start =
          follow === "continuous"
            ? Math.round(frame - length / 2)
            : Math.floor(frame / length) * length;
        const next = clampViewport({ start, end: start + length }, info.frames);
        return next.start === range.start && next.end === range.end ? range : next;
      });
    },
    [playing, follow, info.frames, updateViewport],
  );
  const updatePlayback = useCallback(
    (frame: number) => {
      paintPlayback(frame);
      followPlayback(frame);
    },
    [paintPlayback, followPlayback],
  );
  useImperativeHandle(
    ref,
    () => ({
      zoomIn,
      zoomOut,
      zoomFit,
      zoomSelection,
      selection: () => selectedRange && { start: selectedRange.start, end: selectedRange.end },
      clearSelection: (frame = position) => {
        if (disabled) return;
        interaction.current++;
        selectionDrag.current = undefined;
        const cursor = Math.max(0, Math.min(info.frames, Math.round(frame)));
        editor.commit({ start: cursor, end: cursor, channelMask: selection.channelMask });
      },
      updatePlayback,
    }),
    [
      zoomIn,
      zoomOut,
      zoomFit,
      zoomSelection,
      selectedRange,
      selection.channelMask,
      position,
      disabled,
      info.frames,
      editor.commit,
      updatePlayback,
    ],
  );

  useEffect(() => {
    followPlayback(readPosition?.() ?? position);
  }, [position, followPlayback, readPosition]);
  useLayoutEffect(() => paintPlayback(readPosition?.() ?? position));

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

  const pointerFrame = (event: { currentTarget: HTMLElement; clientX: number }) => {
    const target = event.currentTarget;
    const track = target instanceof HTMLCanvasElement ? target : target.parentElement;
    const bounds = (track ?? target).getBoundingClientRect();
    return Math.round(
      xToFrame(
        Math.max(0, Math.min(width, event.clientX - bounds.left)),
        currentViewport.current,
        width,
      ),
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
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const rawFrame = pointerFrame(event);
    const frame = snapFrame(rawFrame);
    const extending = event.shiftKey;
    const fixed =
      edge === "start"
        ? selection.end
        : edge === "end"
          ? selection.start
          : extending
            ? frame < selection.start + (selection.end - selection.start) / 2
              ? selection.end
              : selection.start
            : frame;
    selectionDrag.current = {
      pointer: event.pointerId,
      anchor: fixed,
      rawAnchor: edge || extending ? fixed : rawFrame,
      snapAnchor: !edge && !extending,
      offset: edge ? rawFrame - selection[edge] : 0,
      previous: selection,
    };
    const moving = edge ? selection[edge] : frame;
    editor.preview({
      start: Math.min(fixed, moving),
      end: Math.max(fixed, moving),
      channelMask: selection.channelMask,
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
      data-selection-start={selection.start}
      data-selection-end={selection.end}
      data-channel-mask={selection.channelMask}
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
      <SelectionBar
        key={info.documentId}
        selection={selection}
        frames={info.frames}
        sampleRate={info.sampleRate}
        channels={info.channels}
        timeFormat={timeFormat}
        disabled={disabled}
        onChange={setSelection}
      />
      <div className="flex flex-wrap items-center gap-3 border-b px-3 py-1.5 text-xs">
        <span>Snap:</span>
        <label>
          <input
            type="checkbox"
            checked={snapZero}
            onChange={(event) => {
              setSnapZero(event.target.checked);
            }}
          />{" "}
          Zero crossings
        </label>
        <label>
          <input
            type="checkbox"
            checked={snapMarkers}
            onChange={(event) => {
              setSnapMarkers(event.target.checked);
            }}
          />{" "}
          Markers / regions
        </label>
        <label>
          <input
            type="checkbox"
            checked={snapTicks}
            onChange={(event) => {
              setSnapTicks(event.target.checked);
            }}
          />{" "}
          Ruler ticks
        </label>
        <input
          aria-label="Marker or region name"
          className="rounded border bg-background px-1 py-0.5"
          value={anchorName}
          maxLength={256}
          disabled={disabled || editor.adding}
          onChange={(event) => setAnchorName(event.target.value)}
          placeholder="Optional name"
        />
        <Button
          size="xs"
          variant="outline"
          disabled={disabled || !client || editor.adding}
          onClick={() => void editor.addAnchor("marker", anchorName)}
        >
          Add marker
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={disabled || !client || editor.adding || !selectedRange}
          onClick={() => void editor.addAnchor("region", anchorName)}
        >
          Add region
        </Button>
      </div>
      {editor.error && (
        <p role="alert" className="px-3 text-xs text-destructive">
          {editor.error}
        </p>
      )}
      <div className="grid border-b" style={sharedColumns}>
        <span className="flex items-center justify-center text-[10px] text-muted-foreground">
          Time
        </span>
        <div className="relative h-7 overflow-hidden" data-testid="waveform-time-ruler">
          {timeline.regions.map(
            (region) =>
              region.end >= viewport.start &&
              region.start <= viewport.end && (
                <button
                  key={`region-${region.id}`}
                  type="button"
                  title={region.name}
                  aria-label={`Select region ${region.name}`}
                  disabled={disabled}
                  className="absolute bottom-0 z-10 h-2 min-w-1 rounded bg-violet-400/50"
                  data-testid={`timeline-region-${region.id}`}
                  style={{
                    left: frameToX(Math.max(viewport.start, region.start), viewport, width),
                    width: Math.max(
                      1,
                      frameToX(Math.min(viewport.end, region.end), viewport, width) -
                        frameToX(Math.max(viewport.start, region.start), viewport, width),
                    ),
                  }}
                  onClick={() =>
                    setSelection({
                      start: region.start,
                      end: region.end,
                      channelMask: selection.channelMask,
                    })
                  }
                />
              ),
          )}
          {timeline.markers.map(
            (marker) =>
              marker.frame >= viewport.start &&
              marker.frame <= viewport.end && (
                <button
                  key={`marker-${marker.id}`}
                  type="button"
                  title={marker.name}
                  aria-label={`Go to marker ${marker.name}`}
                  disabled={disabled}
                  className="absolute top-0 z-20 h-full border-l-2 border-emerald-400 text-[10px] text-emerald-300"
                  data-testid={`timeline-marker-${marker.id}`}
                  style={{ left: Math.min(width - 1, frameToX(marker.frame, viewport, width)) }}
                  onClick={() =>
                    setSelection({
                      start: marker.frame,
                      end: marker.frame,
                      channelMask: selection.channelMask,
                    })
                  }
                >
                  {marker.name}
                </button>
              ),
          )}
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
                <div className="relative min-w-0 overflow-hidden" data-testid="waveform-track">
                  <PeakCanvas
                    client={client}
                    info={info}
                    channel={channel}
                    viewport={viewport}
                    width={width}
                    height={LANE_HEIGHT}
                    dpr={dpr}
                    peaks={
                      channel === 0 && viewport.start === 0 && viewport.end === info.frames
                        ? fullPeaks
                        : undefined
                    }
                    onPointerDown={startSelection}
                    onPointerMove={moveSelection}
                    onPointerUp={endSelection}
                    onPointerCancel={cancelSelection}
                    onLostPointerCapture={cancelSelection}
                    onDoubleClick={selectRegion}
                  />
                  {(selection.channelMask & (1 << channel)) !== 0 &&
                    selectionEnd >= selectionStart && (
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
                  {(selection.channelMask & (1 << channel)) !== 0 &&
                    selectedRange &&
                    (["start", "end"] as const).map(
                      (edge) =>
                        selection[edge] >= viewport.start &&
                        selection[edge] <= viewport.end && (
                          <button
                            key={edge}
                            type="button"
                            aria-label={`Selection ${edge} edge channel ${channel + 1}`}
                            disabled={disabled}
                            data-testid={`selection-${edge}-edge-${channel}`}
                            className="absolute inset-y-0 z-10 w-2 cursor-ew-resize touch-none border-x border-blue-400 bg-blue-400/20"
                            style={{
                              left: Math.max(
                                0,
                                Math.min(width - 8, frameToX(selection[edge], viewport, width) - 4),
                              ),
                            }}
                            onPointerDown={(event) => startSelection(event, edge)}
                            onPointerMove={moveSelection}
                            onPointerUp={endSelection}
                            onPointerCancel={cancelSelection}
                            onLostPointerCapture={cancelSelection}
                            onDoubleClick={selectRegion}
                            onKeyDown={(event) => {
                              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                              event.preventDefault();
                              const frame = Math.max(
                                0,
                                Math.min(
                                  info.frames,
                                  selection[edge] + (event.key === "ArrowLeft" ? -1 : 1),
                                ),
                              );
                              setSelection({
                                start: Math.min(
                                  edge === "start" ? frame : selection.start,
                                  edge === "end" ? frame : selection.end,
                                ),
                                end: Math.max(
                                  edge === "start" ? frame : selection.start,
                                  edge === "end" ? frame : selection.end,
                                ),
                                channelMask: selection.channelMask,
                              });
                            }}
                          />
                        ),
                    )}
                  {info.frames > 0 && (
                    <div
                      ref={(element) => {
                        cursorLines.current[channel] = element;
                      }}
                      aria-hidden="true"
                      data-testid={`play-cursor-${channel}`}
                      data-frame={position}
                      className="pointer-events-none absolute inset-y-0 border-l border-amber-300"
                      style={{ left: Math.min(width - 1, frameToX(position, viewport, width)) }}
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
            peaks={fullPeaks}
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
          {info.frames > 0 && (
            <div
              ref={overviewCursor}
              aria-hidden="true"
              data-testid="play-cursor-overview"
              data-frame={position}
              className="pointer-events-none absolute inset-y-0 border-l border-amber-300"
              style={{ left: Math.min(width - 1, (position / info.frames) * width) }}
            />
          )}
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
