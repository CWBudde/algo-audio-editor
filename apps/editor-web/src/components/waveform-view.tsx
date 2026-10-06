import type { DocumentInfoResult, EditResult, SelectionRange } from "@aae/protocol";
import {
  type Ref,
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
import { FrequencyRuler } from "@/components/waveform/frequency-ruler";
import { SPECTROGRAM_FOOTER_HEIGHT, waveformLaneHeight } from "@/components/waveform/lane-layout";
import { PeakCanvas } from "@/components/waveform/peak-canvas";
import { AmplitudeRuler, TimeRuler } from "@/components/waveform/rulers";
import { TimelineAnchors } from "@/components/waveform/timeline-anchors";
import { useKeyboardSelection } from "@/components/waveform/use-keyboard-selection";
import { useWaveformKeyboard } from "@/components/waveform/use-waveform-keyboard";
import { useWaveformPointer } from "@/components/waveform/use-waveform-pointer";
import { useWaveformViewport } from "@/components/waveform/use-waveform-viewport";
import { usePeaks } from "@/hooks/use-peaks";
import { type SelectionOptions, useSelection } from "@/hooks/use-selection";
import type { KernelClient } from "@/kernel/client";
import { DEFAULT_SPECTRAL_SETTINGS } from "@/lib/analysis-settings";
import type { CommandId, ResolvedCommand } from "@/lib/commands";
import {
  Flag,
  type IconComponent,
  Magnet,
  Maximize2,
  ScanSearch,
  Settings2,
  SlidersHorizontal,
  SquareDashed,
  ZoomIn,
  ZoomOut,
} from "@/lib/icons";
import type { SpectralSelection, SpectralTool } from "@/lib/spectral-selection";
import {
  type AmplitudeScale,
  clampVerticalZoom,
  clampViewport,
  type FrameRange,
  frameToX,
  generateAmplitudeTicks,
  panViewport,
  type TimeFormat,
  VERTICAL_ZOOM_LEVELS,
  zoomViewport,
} from "@/lib/waveform-geometry";
import type { SampleDisplayMode } from "@/lib/waveform-samples";

const RULER_WIDTH = 56;
const OVERVIEW_HEIGHT = 40;
const MAX_SCROLL_WIDTH = 1_000_000;
const MIN_LANES_HEIGHT = 128;

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
  selectionEditor?: ReturnType<typeof useSelection>;
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

export function WaveformView(props: WaveformViewProps) {
  return props.selectionEditor ? (
    <WaveformContent {...props} editor={props.selectionEditor} />
  ) : (
    <StandaloneWaveformView {...props} />
  );
}

function StandaloneWaveformView(props: WaveformViewProps) {
  const editor = useSelection(props.client, props.info, props.initialEdit, {
    ...props.timelineOptions,
    busy: props.disabled || props.timelineOptions?.busy,
  });
  return <WaveformContent {...props} editor={editor} />;
}

function WaveformContent({
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
  editor,
  timelineOptions,
  onExportTimeline,
  commands,
  onExecute,
  spectralView = "waveform",
  spectralSettings = DEFAULT_SPECTRAL_SETTINGS,
  analysisPaused = false,
  analysisStateId,
  onSpectralSelectionChange,
}: WaveformViewProps & { editor: ReturnType<typeof useSelection> }) {
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
  const { selection, timeline } = editor;
  const selectedRange = selection.end > selection.start ? selection : undefined;
  useLayoutEffect(() => onSelectionChange?.(selection), [selection, onSelectionChange]);
  const lanes = useRef<HTMLDivElement>(null);
  const [availableLaneHeight, setAvailableLaneHeight] = useState(0);
  const laneHeight = waveformLaneHeight(
    availableLaneHeight,
    info.channels,
    spectralView === "split",
    spectralView !== "waveform",
  );
  const cursorLines = useRef<(HTMLDivElement | null)[]>([]);
  const overviewCursor = useRef<HTMLDivElement>(null);
  const lanesId = useId();
  const keyboardHelpId = useId();
  const edgeHelpId = useId();
  const {
    fullRange,
    viewport,
    currentViewport,
    updateViewport,
    followPlayback,
    host,
    width,
    dpr,
    resetViewport,
  } = useWaveformViewport(info, lanes, playing, follow);
  const [minimumWorkspaceHeight, setMinimumWorkspaceHeight] = useState(MIN_LANES_HEIGHT);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      const pixels = (value: string) => Number.parseFloat(value) || 0;
      let chromeHeight =
        pixels(style.borderTopWidth) +
        pixels(style.borderBottomWidth) +
        pixels(style.paddingTop) +
        pixels(style.paddingBottom);
      for (const child of element.children) {
        if (child === lanes.current) continue;
        const childStyle = getComputedStyle(child);
        chromeHeight +=
          child.getBoundingClientRect().height +
          pixels(childStyle.marginTop) +
          pixels(childStyle.marginBottom);
      }
      setMinimumWorkspaceHeight(Math.ceil(chromeHeight + MIN_LANES_HEIGHT));
    };
    let observer: ResizeObserver | undefined;
    const observeChrome = () => {
      observer?.disconnect();
      observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
      for (const child of element.children) {
        if (child !== lanes.current) observer?.observe(child);
      }
      measure();
    };
    observeChrome();
    // Wrapped tools/selection/errors must grow the outer scrollable workspace;
    // channel content stays inside its bounded, independently scrolling lanes.
    const mutations = new MutationObserver(observeChrome);
    mutations.observe(element, { childList: true });
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [host]);
  useLayoutEffect(() => {
    const element = lanes.current;
    if (!element) return;
    const measure = () => setAvailableLaneHeight(element.clientHeight);
    measure();
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

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
  const [verticalZoom, setVerticalZoom] = useState(1);
  const changeVerticalZoom = useCallback(
    (zoom: number) => setVerticalZoom(clampVerticalZoom(zoom)),
    [],
  );
  const zoomSession = useRef({ client, documentId: info.documentId });
  useLayoutEffect(() => {
    if (
      zoomSession.current.client !== client ||
      zoomSession.current.documentId !== info.documentId
    ) {
      zoomSession.current = { client, documentId: info.documentId };
      setVerticalZoom(1);
    }
  }, [client, info.documentId]);
  const [sampleMode, setSampleMode] = useState<SampleDisplayMode>("linear");
  const scrollbar = useRef<HTMLDivElement>(null);
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
    resetViewport();
    overviewDrag.current = undefined;
    setAnchorName("");
    setAnchorColor("#a78bfa");
  }, [resetViewport]);

  const {
    selectionDrag,
    interaction,
    setSelection: setPointerSelection,
    startSelection: startPointerSelection,
    moveSelection,
    endSelection,
    cancelSelection,
    selectRegion,
    timeTicks,
  } = useWaveformPointer({
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
  });
  const commandsBlocked = Boolean(
    disabled || timelineOptions?.busy || !client || editor.adding || editor.previewing,
  );
  const interactionDisabled =
    disabled || Boolean(timelineOptions?.busy) || !client || editor.adding || info.frames === 0;
  const keyboardDisabled =
    interactionDisabled || (spectralView !== "waveform" && spectralTool !== "time");
  const keyboardWrites = useKeyboardSelection({
    client,
    info,
    editor,
    disabled: keyboardDisabled,
    onSeek,
  });
  const keyboard = useWaveformKeyboard({
    info,
    session: editor.getSelection,
    getSelection: editor.getSelection,
    disabled: keyboardDisabled,
    hasPreview: editor.isPreview,
    interacting: Boolean(selectionDrag.current),
    ...keyboardWrites,
    interrupt: () => {
      interaction.current++;
    },
    reveal: (frame) =>
      updateViewport((range) => {
        if (frame >= range.start && frame <= range.end) return range;
        const length = range.end - range.start;
        const start = frame < range.start ? frame : frame - length;
        return clampViewport({ start, end: start + length }, info.frames);
      }),
  });
  const setSelection = useCallback(
    (range: SelectionRange) => {
      keyboard.reset();
      setPointerSelection(range);
    },
    [keyboard.reset, setPointerSelection],
  );
  const startSelection: typeof startPointerSelection = (event, edge) => {
    if (disabled || timelineOptions?.busy || editor.adding || event.button !== 0) return;
    keyboard.beforePointer();
    if (!edge)
      event.currentTarget
        .closest<HTMLElement>('[data-testid="waveform-track"]')
        ?.focus({ preventScroll: true });
    startPointerSelection(event, edge);
  };
  const selectAll = useCallback(() => {
    if (commandsBlocked || selectionDrag.current) return;
    setSelection({ start: 0, end: info.frames, channelMask: selection.channelMask });
  }, [commandsBlocked, setSelection, info.frames, selection.channelMask, selectionDrag.current]);
  const addAnchor = useCallback(
    (kind: "marker" | "region") => {
      if (commandsBlocked || selectionDrag.current || (kind === "region" && !selectedRange)) return;
      void editor.addAnchor(kind, anchorName, anchorColor);
    },
    [
      commandsBlocked,
      editor.addAnchor,
      selectedRange,
      anchorName,
      anchorColor,
      selectionDrag.current,
    ],
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
        keyboard.reset();
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
      keyboard.reset,
      updatePlayback,
      selectionDrag,
      interaction,
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

  const amplitudeTicks = generateAmplitudeTicks(laneHeight, amplitudeScale, verticalZoom);
  const imagePanelsHeight = laneHeight * (spectralView === "split" ? 2 : 1);
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
    icon: IconComponent,
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
      className="waveform-workspace flex min-h-[20rem] min-w-0 flex-1 flex-col overflow-hidden rounded-lg border"
      style={{ minHeight: `max(20rem, ${minimumWorkspaceHeight}px)` }}
      data-testid="waveform-view"
      data-document-id={info.documentId}
      data-vertical-zoom={verticalZoom}
      data-start-frame={viewport.start}
      data-end-frame={viewport.end}
      data-selection-start={selection.start}
      data-selection-end={selection.end}
      data-channel-mask={selection.channelMask}
    >
      <div
        className="waveform-toolbar flex min-h-9 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-2 py-1"
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
                Vertical zoom
                <select
                  aria-label="Vertical zoom"
                  className="studio-field rounded border p-1"
                  value={verticalZoom}
                  disabled={spectralView === "spectrogram"}
                  onChange={(event) => changeVerticalZoom(Number(event.target.value))}
                >
                  {VERTICAL_ZOOM_LEVELS.map((zoom) => (
                    <option key={zoom} value={zoom}>
                      {zoom}×
                    </option>
                  ))}
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
                Peak / RMS at overview zoom; sample dots and connections above one pixel per sample.{" "}
                Scroll the amplitude ruler or press + / − to magnify vertically; Home or
                double-click resets.
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
        <span
          className="hidden min-w-0 flex-1 basis-0 truncate px-2 text-right text-xs font-medium text-muted-foreground sm:block"
          title={info.name}
        >
          {info.name}
        </span>
      </div>
      {spectralView !== "waveform" && (
        <fieldset
          aria-label="Spectral editing"
          className="waveform-toolbar flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5 text-xs"
        >
          <label className="flex items-center gap-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Spectrogram selection
            </span>
            <select
              aria-label="Spectrogram selection tool"
              className="studio-field rounded border px-2 py-1 text-xs"
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
              <span role="status" className="min-w-0 font-mono text-[10px] text-muted-foreground">
                Spectral selection: frames {spectralSelection.mask.start}–
                {spectralSelection.mask.end}, {spectralSelection.mask.lowHz.toFixed(0)}–
                {spectralSelection.mask.highHz.toFixed(0)} Hz
              </span>
              <button
                type="button"
                disabled={disabled}
                className="studio-button rounded border px-2 py-1 text-xs disabled:opacity-50"
                onClick={() => changeSpectralSelection(undefined)}
              >
                Clear spectral selection
              </button>
              {(["attenuate", "remove", "heal"] as const).map((action) => (
                <button
                  key={action}
                  type="button"
                  disabled={!commands?.find((c) => c.id === `process.spectral-${action}`)?.enabled}
                  className="studio-button rounded border px-2 py-1 text-xs disabled:opacity-50"
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
        </fieldset>
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
      <div className="waveform-ruler grid shrink-0 border-b" style={sharedColumns}>
        <span className="flex items-center justify-center text-[10px] text-muted-foreground">
          Time
        </span>
        <div className="relative h-6 overflow-hidden" data-testid="waveform-time-ruler">
          <TimelineAnchors
            timeline={timeline}
            viewport={viewport}
            width={width}
            disabled={disabled}
            selection={selection}
            onSelect={setSelection}
          />
          <TimeRuler ticks={timeTicks} />
        </div>
      </div>
      <div
        ref={lanes}
        id={lanesId}
        data-testid="waveform-lanes"
        className="waveform-lanes min-h-0 flex-1 overflow-y-auto overscroll-contain"
        style={{ scrollbarGutter: "stable", minHeight: MIN_LANES_HEIGHT }}
      >
        <p id={keyboardHelpId} className="sr-only">
          Left and Right move one frame. Shift extends the selection. Home and End jump to the
          document boundaries.
        </p>
        <p id={edgeHelpId} className="sr-only">
          Arrow keys move one frame, or ten frames with Shift. Page Up increases and Page Down
          decreases by one second, or ten seconds with Shift. Home and End jump to the allowed
          boundaries.
        </p>
        {info.frames === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            No audio frames in this document.
          </p>
        ) : (
          channelIds.map((channel) => (
            <div key={channel} className="waveform-channel border-b">
              <div className="waveform-channel-header flex h-6 min-w-0 items-center gap-2 border-b px-3 text-[10px] text-muted-foreground">
                <span className="w-8 font-mono tabular-nums">
                  {String(channel + 1).padStart(2, "0")}
                </span>
                <span className="min-w-0 truncate font-medium uppercase tracking-widest">
                  Channel {channel + 1}
                </span>
                {verticalZoom > 1 && spectralView !== "spectrogram" && (
                  <span
                    className="shrink-0 font-mono tabular-nums text-primary"
                    title="Display-only vertical magnification"
                  >
                    {verticalZoom}× vertical
                  </span>
                )}
                <span className="ml-auto uppercase tracking-widest">
                  {info.channels === 1
                    ? "Mono"
                    : info.channels === 2
                      ? channel === 0
                        ? "Left"
                        : "Right"
                      : "Audio"}
                </span>
              </div>
              <div
                className="grid"
                style={{ gridTemplateColumns: `${RULER_WIDTH}px minmax(0, 1fr)` }}
              >
                <div>
                  {spectralView !== "spectrogram" && (
                    <AmplitudeRuler
                      channel={channel}
                      height={laneHeight}
                      verticalZoom={verticalZoom}
                      onZoomChange={changeVerticalZoom}
                      ticks={amplitudeTicks}
                    />
                  )}
                  {spectralView !== "waveform" && (
                    <>
                      <FrequencyRuler
                        channel={channel}
                        height={laneHeight}
                        sampleRate={info.sampleRate}
                      />
                      <div
                        aria-hidden="true"
                        className="border-r"
                        style={{ height: SPECTROGRAM_FOOTER_HEIGHT }}
                      />
                    </>
                  )}
                </div>
                <fieldset
                  className="waveform-track-surface relative min-w-0 overflow-hidden focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                  data-testid="waveform-track"
                  aria-label={`Channel ${channel + 1} waveform editor`}
                  aria-describedby={keyboardHelpId}
                  aria-disabled={interactionDisabled}
                  tabIndex={keyboardDisabled ? -1 : 0}
                  onKeyDown={keyboard.onSurfaceKeyDown}
                  onKeyUp={keyboard.onKeyUp}
                  onBlur={keyboard.onBlur}
                >
                  {spectralView !== "spectrogram" && (
                    <PeakCanvas
                      client={client}
                      info={info}
                      channel={channel}
                      viewport={viewport}
                      width={width}
                      height={laneHeight}
                      dpr={dpr}
                      sampleMode={sampleMode}
                      verticalZoom={verticalZoom}
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
                        height={laneHeight}
                        settings={spectralSettings}
                        paused={analysisPaused}
                        stateId={analysisStateId}
                        onPointerDown={startSelection}
                        onPointerMove={moveSelection}
                        onPointerUp={endSelection}
                        onPointerCancel={cancelSelection}
                        onLostPointerCapture={cancelSelection}
                        onDoubleClick={selectRegion}
                      >
                        <SpectralSelectionLayer
                          key={info.documentId}
                          documentId={info.documentId}
                          frames={info.frames}
                          sampleRate={info.sampleRate}
                          channel={channel}
                          viewport={viewport}
                          width={width}
                          height={laneHeight}
                          tool={spectralTool}
                          selection={spectralSelection}
                          disabled={disabled}
                          onChange={changeSpectralSelection}
                        />
                      </SpectrogramCanvas>
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
                        className="pointer-events-none absolute top-0 border border-selection bg-selection-fill"
                        style={{
                          height: imagePanelsHeight,
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
                    info.frames > 0 &&
                    (["start", "end"] as const).map(
                      (edge) =>
                        selection[edge] >= viewport.start &&
                        selection[edge] <= viewport.end && (
                          <button
                            key={edge}
                            type="button"
                            role="slider"
                            aria-label={`Selection ${edge} edge channel ${channel + 1}`}
                            aria-describedby={edgeHelpId}
                            aria-orientation="horizontal"
                            aria-valuemin={edge === "start" ? 0 : selection.start}
                            aria-valuemax={edge === "start" ? selection.end : info.frames}
                            aria-valuenow={selection[edge]}
                            aria-valuetext={`${selection[edge]} frames, ${(selection[edge] / info.sampleRate).toFixed(6)} seconds`}
                            disabled={
                              disabled || Boolean(timelineOptions?.busy) || !client || editor.adding
                            }
                            data-testid={`selection-${edge}-edge-${channel}`}
                            className="absolute top-0 z-10 w-2 cursor-ew-resize touch-none border-x border-selection bg-selection-fill"
                            style={{
                              height: imagePanelsHeight,
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
                            onKeyDown={(event) => keyboard.onEdgeKeyDown(event, edge)}
                            onKeyUp={keyboard.onKeyUp}
                            onBlur={keyboard.onBlur}
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
                      className="pointer-events-none absolute top-0 border-l border-playhead"
                      style={{
                        height: imagePanelsHeight,
                        left: Math.min(width - 1, frameToX(position, viewport, width)),
                      }}
                    />
                  )}
                </fieldset>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="waveform-overview grid shrink-0 border-t" style={sharedColumns}>
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
      <div className="grid shrink-0" style={sharedColumns}>
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
          className="h-4 min-w-0 overflow-x-scroll overflow-y-hidden"
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
