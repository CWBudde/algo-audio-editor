import type { DocumentInfoResult, EditResult, SelectionRange } from "@aae/protocol";
import {
  Flag,
  type LucideIcon,
  Magnet,
  Maximize2,
  ScanSearch,
  Settings2,
  SlidersHorizontal,
  SquareDashed,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
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
import { ControlDisclosure } from "@/components/control-disclosure";
import { IconAction } from "@/components/icon-action";
import { SelectionBar } from "@/components/selection-bar";
import { SpectralSelectionLayer } from "@/components/spectral-selection-layer";
import { SpectrogramCanvas } from "@/components/spectrogram-canvas";
import { TimelinePanel } from "@/components/timeline-panel";
import type { PlaybackFollow } from "@/components/transport-bar";
import { type PeaksState, usePeaks, useWaveformPeaks } from "@/hooks/use-peaks";
import { type SelectionOptions, useSelection } from "@/hooks/use-selection";
import type { KernelClient } from "@/kernel/client";
import type { PeakViews } from "@/kernel/peak-data";
import { DEFAULT_SPECTRAL_SETTINGS } from "@/lib/analysis-settings";
import type { CommandId, ResolvedCommand } from "@/lib/commands";
import { resolveEditorPalette } from "@/lib/editor-theme";
import { snapSelectionFrame } from "@/lib/selection";
import type { SpectralSelection, SpectralTool } from "@/lib/spectral-selection";
import { drawSampleWaveform, drawWaveform, resizeCanvas } from "@/lib/waveform-drawing";
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
import { type SampleDisplayMode, sampleViewportRange } from "@/lib/waveform-samples";

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
  selectionState(): SelectionRange | undefined;
  selectAll(): void;
  addMarker(): void;
  addRegion(): void;
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
  onSelectionChange?(selection: SelectionRange): void;
  onCommandStateChange?(ready: boolean): void;
  initialEdit?: Pick<EditResult, "selection" | "timeline">;
  timelineOptions?: SelectionOptions;
  onExportTimeline?(format: "csv" | "labels"): void;
  commands?: readonly ResolvedCommand[];
  onExecute?(id: CommandId): void;
  spectralView?: "waveform" | "spectrogram" | "split";
  spectralSettings?: import("@/lib/analysis-settings").SpectralSettings;
  analysisPaused?: boolean;
  analysisStateId?: string;
  onSpectralSelectionChange?(selection: SpectralSelection | undefined): void;
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
  sampleMode?: SampleDisplayMode;
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
  sampleMode = "linear",
  ...events
}: PeakCanvasProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const sampleRange = overview ? undefined : sampleViewportRange(viewport, info.frames, width);
  const ownPeaks = useWaveformPeaks(
    client,
    info,
    sampleRange
      ? { channel, startFrame: sampleRange.start, endFrame: sampleRange.end, buckets: 1 }
      : !peaks && info.frames > 0
        ? {
            channel,
            startFrame: viewport.start,
            endFrame: viewport.end,
            buckets: Math.max(1, Math.min(8192, Math.ceil(width * dpr))),
          }
        : undefined,
    Boolean(sampleRange),
  );
  const data = sampleRange ? undefined : (peaks?.data ?? ownPeaks.pages?.[0]);
  const pages = sampleRange ? ownPeaks.pages : undefined;
  const { loading, error } = !sampleRange && peaks ? peaks : ownPeaks;
  const source = pages ?? data;
  const displayMode = sampleRange ? sampleMode : "envelope";
  const [paint, setPaint] = useState<{
    source: PeakViews | readonly PeakViews[];
    mode: typeof displayMode;
    start: number;
    end: number;
    width: number;
    dpr: number;
  }>();

  useLayoutEffect(() => {
    // Paint bookkeeping must not keep obsolete sample pages alive after a request clears.
    if (!source) setPaint(undefined);
    const element = canvas.current;
    if (!element) return;
    const context = resizeCanvas(element, width, height, dpr);
    if (!context) return;
    const palette = resolveEditorPalette(element);
    const colors = {
      background: palette.waveformBackground,
      peakColor: palette.waveformPeak,
      sampleColor: palette.waveformSample,
      rmsColor: palette.waveformRms,
      showRMS: !overview,
    };
    if (displayMode === "envelope") {
      drawWaveform(context, data ?? null, viewport, width, height, colors);
    } else {
      drawSampleWaveform(context, pages, viewport, width, height, displayMode, colors);
    }
    if (source)
      setPaint({ source, mode: displayMode, start: viewport.start, end: viewport.end, width, dpr });
  }, [source, data, pages, displayMode, viewport, width, height, dpr, overview]);

  const rendered = Boolean(
    source &&
      paint?.source === source &&
      paint.mode === displayMode &&
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
        data-display-mode={displayMode}
        data-sample-start={sampleRange?.start}
        data-sample-end={sampleRange?.end}
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
  onSelectionChange,
  onCommandStateChange,
  initialEdit,
  timelineOptions,
  onExportTimeline,
  commands,
  onExecute,
  spectralView = "waveform",
  spectralSettings = DEFAULT_SPECTRAL_SETTINGS,
  analysisPaused = false,
  analysisStateId,
  onSpectralSelectionChange,
}: WaveformViewProps) {
  const [spectralTool, setSpectralTool] = useState<SpectralTool>("time");
  const [spectralSelection, setSpectralSelection] = useState<SpectralSelection>();
  const changeSpectralSelection = (value: SpectralSelection | undefined) => {
    setSpectralSelection(value);
    onSpectralSelectionChange?.(value);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: Selection geometry belongs to this kernel/document session.
  useLayoutEffect(() => {
    setSpectralSelection(undefined);
    onSpectralSelectionChange?.(undefined);
  }, [client, info.documentId, onSpectralSelectionChange]);
  const fullRange = useMemo(() => ({ start: 0, end: info.frames }), [info]);
  const [state, setState] = useState<ViewState>({
    document: info,
    viewport: fullRange,
  });
  const current = state.document === info ? state : { document: info, viewport: fullRange };
  const { viewport } = current;
  const editor = useSelection(client, info, initialEdit, {
    ...timelineOptions,
    busy: disabled || timelineOptions?.busy,
  });
  const { selection, timeline } = editor;
  const selectedRange = selection.end > selection.start ? selection : undefined;
  useLayoutEffect(() => onSelectionChange?.(selection), [selection, onSelectionChange]);
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
  const [sampleMode, setSampleMode] = useState<SampleDisplayMode>("linear");
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
  const [anchorColor, setAnchorColor] = useState("#a78bfa");
  const overviewDrag = useRef<{ pointer: number; x: number; viewport: FrameRange } | undefined>(
    undefined,
  );
  const pendingScroll = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    setState({ document: info, viewport: fullRange });
    interaction.current++;
    selectionDrag.current = undefined;
    overviewDrag.current = undefined;
    setAnchorName("");
    setAnchorColor("#a78bfa");
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
  const commandsBlocked = Boolean(
    disabled || timelineOptions?.busy || !client || editor.adding || editor.previewing,
  );
  const selectAll = useCallback(() => {
    if (commandsBlocked || selectionDrag.current) return;
    setSelection({ start: 0, end: info.frames, channelMask: selection.channelMask });
  }, [commandsBlocked, setSelection, info.frames, selection.channelMask]);
  const addAnchor = useCallback(
    (kind: "marker" | "region") => {
      if (commandsBlocked || selectionDrag.current || (kind === "region" && !selectedRange)) return;
      void editor.addAnchor(kind, anchorName, anchorColor);
    },
    [commandsBlocked, editor.addAnchor, selectedRange, anchorName, anchorColor],
  );
  const addMarker = useCallback(() => addAnchor("marker"), [addAnchor]);
  const addRegion = useCallback(() => addAnchor("region"), [addAnchor]);

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
      // Edits must not capture an unfinished drag or pending zero snap.
      selectionState: () => (selectionDrag.current || editor.previewing ? undefined : selection),
      selectAll,
      addMarker,
      addRegion,
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
      selectAll,
      addMarker,
      addRegion,
      selection,
      selection.channelMask,
      position,
      disabled,
      info.frames,
      editor.commit,
      editor.previewing,
      updatePlayback,
    ],
  );
  useLayoutEffect(
    () => onCommandStateChange?.(!editor.previewing && !editor.adding),
    [onCommandStateChange, editor.previewing, editor.adding],
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
  const action = (
    id: CommandId,
    icon: LucideIcon,
    label: string,
    fallback: () => void,
    blocked: boolean,
  ) => {
    const command = commands?.find((item) => item.id === id);
    return (
      <IconAction
        icon={icon}
        label={label}
        disabled={blocked || (commands !== undefined && !command?.enabled)}
        shortcutLabel={command?.shortcutLabel}
        ariaShortcut={command?.ariaShortcut}
        onClick={() => (onExecute ? onExecute(id) : fallback())}
      />
    );
  };
  const snapCount = Number(snapZero) + Number(snapMarkers) + Number(snapTicks);

  return (
    <section
      ref={host}
      className="flex h-full min-h-[24rem] min-w-0 flex-col"
      data-testid="waveform-view"
      data-document-id={info.documentId}
      data-start-frame={viewport.start}
      data-end-frame={viewport.end}
      data-selection-start={selection.start}
      data-selection-end={selection.end}
      data-channel-mask={selection.channelMask}
    >
      <div
        className="flex min-h-9 flex-wrap items-center gap-2 border-b px-3 py-1"
        data-testid="view-controls"
      >
        <fieldset aria-label="Zoom" className="flex items-center gap-1">
          {action("view.zoom-in", ZoomIn, "Zoom in", zoomIn, info.frames === 0 || span <= 1)}
          {action("view.zoom-out", ZoomOut, "Zoom out", zoomOut, span >= info.frames)}
          {action("view.zoom-fit", Maximize2, "Zoom to fit", zoomFit, info.frames === 0)}
          {action(
            "view.zoom-selection",
            ScanSearch,
            "Zoom to selection",
            zoomSelection,
            !selectedRange,
          )}
        </fieldset>
        <fieldset
          aria-label="Display and snapping"
          className="flex items-center gap-1 border-l pl-2"
        >
          <ControlDisclosure className="relative" data-testid="view-settings">
            <summary
              className="flex size-7 cursor-pointer list-none items-center justify-center rounded hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
              title="View settings"
            >
              <SlidersHorizontal className="size-4" aria-hidden="true" />
              <span className="sr-only">View settings</span>
            </summary>
            <div
              data-disclosure-panel
              className="absolute left-0 top-full z-40 grid w-72 gap-3 rounded border bg-popover p-3 text-xs shadow-lg"
            >
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
              <label className="flex items-center gap-1 text-xs">
                Sample display
                <select
                  aria-label="Sample display"
                  data-testid="waveform-display-mode"
                  className="rounded border bg-background p-1"
                  value={sampleMode}
                  onChange={(event) => setSampleMode(event.target.value as SampleDisplayMode)}
                >
                  <option value="linear">Linear</option>
                  <option value="steps">Steps</option>
                </select>
              </label>

              <p className="text-muted-foreground">
                Peak / RMS at overview zoom; sample dots and connections above one pixel per sample.
              </p>
            </div>
          </ControlDisclosure>
          <ControlDisclosure
            className="relative"
            data-testid="snap-settings"
            data-active={snapCount > 0}
          >
            <summary
              className="flex h-7 cursor-pointer list-none items-center justify-center gap-1 rounded px-1 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
              title={snapCount > 0 ? `Snap settings — ${snapCount} active` : "Snap settings"}
            >
              <Magnet
                className={`size-4 ${snapCount > 0 ? "text-warning" : ""}`}
                aria-hidden="true"
              />
              <span className="sr-only">Snap settings{snapCount > 0 ? " — active" : ""}</span>
              {snapCount > 0 && (
                <span className="text-[10px] tabular-nums" aria-hidden="true">
                  {snapCount}
                </span>
              )}
            </summary>
            <div
              data-disclosure-panel
              className="absolute left-0 top-full z-40 grid w-56 gap-3 rounded border bg-popover p-3 text-xs shadow-lg"
            >
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
            </div>
          </ControlDisclosure>
        </fieldset>
        <fieldset aria-label="Annotations" className="flex items-center gap-1 border-l pl-2">
          {action("timeline.add-marker", Flag, "Add marker", addMarker, commandsBlocked)}
          {action(
            "timeline.add-region",
            SquareDashed,
            "Add region",
            addRegion,
            commandsBlocked || !selectedRange,
          )}
          <ControlDisclosure className="relative" data-testid="annotation-settings">
            <summary
              className="flex size-7 cursor-pointer list-none items-center justify-center rounded hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
              title="Annotation options"
            >
              <Settings2 className="size-4" aria-hidden="true" />
              <span className="sr-only">Annotation options</span>
            </summary>
            <div
              data-disclosure-panel
              className="absolute left-0 top-full z-40 grid w-64 gap-3 rounded border bg-popover p-3 text-xs shadow-lg"
            >
              <label className="grid gap-1">
                Name
                <input
                  aria-label="Marker or region name"
                  className="rounded border bg-background px-1 py-0.5"
                  value={anchorName}
                  maxLength={256}
                  disabled={disabled || editor.adding}
                  onChange={(event) => setAnchorName(event.target.value)}
                  placeholder="Optional name"
                />
              </label>
              <label className="flex items-center gap-2">
                Color
                <input
                  type="color"
                  aria-label="Marker or region color"
                  value={anchorColor}
                  disabled={disabled || editor.adding}
                  onChange={(event) => setAnchorColor(event.target.value)}
                />
              </label>
            </div>
          </ControlDisclosure>
          <TimelinePanel
            sessionKey={client ?? info}
            info={info}
            timeline={timeline}
            selection={selection}
            timeFormat={timeFormat}
            busy={disabled || !client || editor.adding || editor.previewing}
            onUpdateMarker={(changes) => {
              if (!selectionDrag.current) void editor.updateMarker(changes);
            }}
            onUpdateRegion={(changes) => {
              if (!selectionDrag.current) void editor.updateRegion(changes);
            }}
            onRemoveMarker={(id) => {
              if (!selectionDrag.current) void editor.removeMarker(id);
            }}
            onRemoveRegion={(id) => {
              if (!selectionDrag.current) void editor.removeRegion(id);
            }}
            onJump={(range) => {
              if (!selectionDrag.current && !editor.previewing) setSelection(range);
            }}
            onExport={
              onExportTimeline &&
              ((format) => {
                if (!selectionDrag.current && !editor.previewing) onExportTimeline(format);
              })
            }
          />
        </fieldset>
      </div>
      {spectralView !== "waveform" && (
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1 text-xs">
          <label>
            Spectrogram selection{" "}
            <select
              aria-label="Spectrogram selection tool"
              className="ml-2 rounded border bg-background px-2 py-1"
              disabled={disabled}
              value={spectralTool}
              onChange={(event) => {
                setSpectralTool(event.target.value as SpectralTool);
              }}
            >
              <option value="time">Time range</option>
              <option value="rectangle">Rectangle</option>
              <option value="lasso">Lasso</option>
            </select>
          </label>
          {spectralSelection?.documentId === info.documentId && (
            <>
              <span role="status">
                Spectral selection: frames {spectralSelection.mask.start}–
                {spectralSelection.mask.end}, {spectralSelection.mask.lowHz.toFixed(0)}–
                {spectralSelection.mask.highHz.toFixed(0)} Hz
              </span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => changeSpectralSelection(undefined)}
              >
                Clear spectral selection
              </button>
              {(["attenuate", "remove", "heal"] as const).map((action) => (
                <button
                  key={action}
                  type="button"
                  disabled={!commands?.find((c) => c.id === `process.spectral-${action}`)?.enabled}
                  onClick={() => onExecute?.(`process.spectral-${action}`)}
                >
                  {action === "attenuate"
                    ? "Attenuate…"
                    : action === "remove"
                      ? "Remove…"
                      : "Heal…"}
                </button>
              ))}
            </>
          )}
        </div>
      )}
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
                  className="absolute bottom-0 z-10 h-2 min-w-1 rounded"
                  data-testid={`timeline-region-${region.id}`}
                  style={{
                    backgroundColor: `${region.color}80`,
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
                  className="absolute top-0 z-20 h-full border-l-2 text-[10px]"
                  data-testid={`timeline-marker-${marker.id}`}
                  style={{
                    left: Math.min(width - 1, frameToX(marker.frame, viewport, width)),
                    borderColor: marker.color,
                    color: marker.color,
                  }}
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
                  {(spectralView === "spectrogram"
                    ? [
                        { value: info.sampleRate / 2, y: 8, label: `${info.sampleRate / 2} Hz` },
                        { value: 0, y: LANE_HEIGHT - 8, label: "0 Hz" },
                      ]
                    : amplitudeTicks
                  ).map((tick) => (
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
                  {spectralView !== "spectrogram" && (
                    <PeakCanvas
                      client={client}
                      info={info}
                      channel={channel}
                      viewport={viewport}
                      width={width}
                      height={LANE_HEIGHT}
                      dpr={dpr}
                      sampleMode={sampleMode}
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
                  )}
                  {spectralView !== "waveform" && (
                    <div className="relative">
                      <SpectrogramCanvas
                        client={client}
                        info={info}
                        channel={channel}
                        viewport={viewport}
                        width={width}
                        height={LANE_HEIGHT}
                        settings={spectralSettings}
                        paused={analysisPaused}
                        stateId={analysisStateId}
                        onPointerDown={startSelection}
                        onPointerMove={moveSelection}
                        onPointerUp={endSelection}
                        onPointerCancel={cancelSelection}
                        onLostPointerCapture={cancelSelection}
                        onDoubleClick={selectRegion}
                      />
                      <SpectralSelectionLayer
                        key={info.documentId}
                        documentId={info.documentId}
                        frames={info.frames}
                        sampleRate={info.sampleRate}
                        channel={channel}
                        viewport={viewport}
                        width={width}
                        height={LANE_HEIGHT}
                        tool={spectralTool}
                        selection={spectralSelection}
                        disabled={disabled}
                        onChange={changeSpectralSelection}
                      />
                    </div>
                  )}
                  {(spectralView === "waveform" || spectralTool === "time") &&
                    (selection.channelMask & (1 << channel)) !== 0 &&
                    selectionEnd >= selectionStart && (
                      <div
                        aria-hidden="true"
                        data-testid={
                          channel === 0 ? "waveform-selection" : `waveform-selection-${channel}`
                        }
                        className="pointer-events-none absolute inset-y-0 border border-selection bg-selection-fill"
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
                  {(spectralView === "waveform" || spectralTool === "time") &&
                    (selection.channelMask & (1 << channel)) !== 0 &&
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
                            className="absolute inset-y-0 z-10 w-2 cursor-ew-resize touch-none border-x border-selection bg-selection-fill"
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
                      className="pointer-events-none absolute inset-y-0 border-l border-playhead"
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
            className="absolute inset-y-0 cursor-grab border-2 border-selection bg-selection-fill focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
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
              className="pointer-events-none absolute inset-y-0 border-l border-playhead"
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
