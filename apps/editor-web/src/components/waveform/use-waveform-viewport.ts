import type { DocumentInfoResult } from "@aae/protocol";
import { type RefObject, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PlaybackFollow } from "@/components/transport-bar";
import { WAVEFORM_RULER_WIDTH } from "@/components/waveform/lane-layout";
import { clampViewport, type FrameRange } from "@/lib/waveform-geometry";

interface ViewState {
  document: DocumentInfoResult;
  viewport: FrameRange;
}

/** CSS geometry and backing-store resolution are tracked independently. */
function useViewSize(tracks: RefObject<HTMLDivElement | null>, rulerWidth: number) {
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

  return { host, width: Math.max(1, width - rulerWidth), dpr };
}

export function useWaveformViewport(
  info: DocumentInfoResult,
  lanes: RefObject<HTMLDivElement | null>,
  playing: boolean,
  follow: PlaybackFollow,
  rulerWidth = WAVEFORM_RULER_WIDTH,
) {
  const fullRange = useMemo(() => ({ start: 0, end: info.frames }), [info.frames]);
  const [state, setState] = useState<ViewState>({
    document: info,
    viewport: fullRange,
  });
  const current = state.document === info ? state : { document: info, viewport: fullRange };
  const { viewport } = current;
  const { host, width, dpr } = useViewSize(lanes, rulerWidth);
  const currentViewport = useRef(viewport);
  currentViewport.current = viewport;
  const lastFollow = useRef(-Infinity);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A follow-mode/transport change starts a new cadence.
  useLayoutEffect(() => {
    lastFollow.current = -Infinity;
  }, [playing, follow]);
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

  const followPlayback = useCallback(
    (frame: number) => {
      if (!playing || follow === "off" || info.frames === 0) return;
      const range = currentViewport.current;
      const length = range.end - range.start;
      if (length >= info.frames || (follow === "page" && frame >= range.start && frame < range.end))
        return;
      // The playhead paints each quantum; peak/ruler geometry commits at most 10 Hz.
      const now = performance.now();
      if (follow === "continuous" && now - lastFollow.current < 100) return;
      lastFollow.current = now;
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
  const resetViewport = useCallback(() => {
    lastFollow.current = -Infinity;
    setState({ document: info, viewport: fullRange });
  }, [info, fullRange]);
  return {
    fullRange,
    viewport,
    currentViewport,
    updateViewport,
    followPlayback,
    host,
    width,
    dpr,
    resetViewport,
  };
}
