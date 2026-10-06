import type { DocumentInfoResult } from "@aae/protocol";
import { type MouseEvent, type PointerEvent, useLayoutEffect, useRef, useState } from "react";
import { type PeaksState, useWaveformPeaks } from "@/hooks/use-peaks";
import type { KernelClient } from "@/kernel/client";
import type { PeakViews } from "@/kernel/peak-data";
import { resolveEditorPalette } from "@/lib/editor-theme";
import { drawSampleWaveform, drawWaveform, resizeCanvas } from "@/lib/waveform-drawing";
import {
  clampVerticalZoom,
  type FrameRange,
  generateTimeTicks,
  generateTimeSubTicks,
  type TimeFormat,
} from "@/lib/waveform-geometry";
import { type SampleDisplayMode, sampleViewportRange } from "@/lib/waveform-samples";

interface PeakCanvasProps {
  client: KernelClient | undefined;
  info: DocumentInfoResult;
  channel: number;
  viewport: FrameRange;
  width: number;
  height: number;
  dpr: number;
  overview?: boolean;
  verticalZoom?: number;
  timeFormat?: TimeFormat;
  peaks?: PeaksState;
  sampleMode?: SampleDisplayMode;
  onPointerDown?: (event: PointerEvent<HTMLCanvasElement>) => void;
  onPointerMove?: (event: PointerEvent<HTMLCanvasElement>) => void;
  onPointerUp?: (event: PointerEvent<HTMLCanvasElement>) => void;
  onPointerCancel?: (event: PointerEvent<HTMLCanvasElement>) => void;
  onLostPointerCapture?: (event: PointerEvent<HTMLCanvasElement>) => void;
  onDoubleClick?: (event: MouseEvent<HTMLCanvasElement>) => void;
}

export function PeakCanvas({
  client,
  info,
  channel,
  viewport,
  width,
  height,
  dpr,
  overview = false,
  verticalZoom = 1,
  timeFormat = "seconds",
  peaks,
  sampleMode = "linear",
  ...events
}: PeakCanvasProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const magnification = overview ? 1 : clampVerticalZoom(verticalZoom);
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
    info: DocumentInfoResult;
    client: KernelClient | undefined;
    mode: typeof displayMode;
    start: number;
    end: number;
    width: number;
    height: number;
    dpr: number;
    verticalZoom: number;
    timeFormat: TimeFormat;
  }>();

  const lastPaint = useRef(paint);
  lastPaint.current = paint;
  useLayoutEffect(() => {
    const previous = lastPaint.current;
    // Keep the previous canvas intact during a same-document viewport refill.
    if (
      loading &&
      previous?.info === info &&
      previous.client === client &&
      previous.width === width &&
      previous.height === height &&
      previous.timeFormat === timeFormat &&
      previous.verticalZoom === magnification &&
      previous.dpr === dpr
    )
      return;
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
      gridColor: overview ? undefined : palette.waveformGrid,
      timeGuides: overview
        ? undefined
        : [
            ...generateTimeTicks(viewport, width, info.sampleRate, timeFormat).map((tick) => ({
              x: tick.x,
              kind: "major" as const,
            })),
            ...generateTimeSubTicks(viewport, width, info.sampleRate, timeFormat),
          ],
      centerLineColor: overview ? undefined : palette.waveformCenter,
      showRMS: !overview,
      verticalZoom: magnification,
    };
    if (displayMode === "envelope") {
      drawWaveform(context, data ?? null, viewport, width, height, colors);
    } else {
      drawSampleWaveform(context, pages, viewport, width, height, displayMode, colors);
    }
    if (source)
      setPaint({
        source,
        info,
        client,
        mode: displayMode,
        start: viewport.start,
        end: viewport.end,
        width,
        height,
        dpr,
        verticalZoom: magnification,
        timeFormat,
      });
  }, [
    source,
    data,
    pages,
    displayMode,
    viewport,
    width,
    height,
    dpr,
    overview,
    loading,
    info,
    client,
    magnification,
    timeFormat,
  ]);

  const rendered = Boolean(
    !loading &&
      source &&
      paint?.source === source &&
      paint.mode === displayMode &&
      paint.start === viewport.start &&
      paint.end === viewport.end &&
      paint.width === width &&
      paint.height === height &&
      paint.verticalZoom === magnification &&
      paint.timeFormat === timeFormat &&
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
        data-vertical-zoom={magnification}
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
