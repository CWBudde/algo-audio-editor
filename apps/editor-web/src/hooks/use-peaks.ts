import type { PeaksGetParams } from "@aae/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KernelClient } from "@/kernel/client";
import { decodePeaks, type PeakViews } from "@/kernel/peak-data";
import { MAX_SAMPLE_PAGE_FRAMES, MAX_SAMPLE_VIEW_FRAMES } from "@/lib/waveform-samples";

type PeakClient = Pick<KernelClient, "call">;

interface PeakRequest {
  client: PeakClient;
  documentKey: object;
  params: PeaksGetParams;
  samples: boolean;
}

interface PeakSnapshot {
  request: PeakRequest;
  pages: readonly PeakViews[] | undefined;
  error: string | undefined;
}

export interface PeaksState {
  data: PeakViews | undefined;
  loading: boolean;
  error: string | undefined;
}

export type SamplePeaksParams = Omit<PeaksGetParams, "buckets">;

export interface SamplePeaksState {
  pages: readonly PeakViews[] | undefined;
  loading: boolean;
  error: string | undefined;
}

/** Exact one-frame summaries, including caller-selected boundary context.
 * One logical viewport can span multiple bounded requests; partial/stale pages
 * are never published, and page buffers remain zero-copy typed-array views. */
export function useSamplePeaks(
  client: PeakClient | undefined,
  documentKey: object,
  params: SamplePeaksParams | undefined,
): SamplePeaksState {
  return useWaveformPeaks(
    client,
    documentKey,
    params ? { ...params, buckets: MAX_SAMPLE_PAGE_FRAMES } : undefined,
    true,
  );
}

/** Request kernel-computed peaks, keeping one RPC and only the latest pending viewport. */
export function usePeaks(
  client: PeakClient | undefined,
  documentKey: object,
  params: PeaksGetParams | undefined,
): PeaksState {
  const state = useWaveformPeaks(client, documentKey, params, false);
  return { data: state.pages?.[0], loading: state.loading, error: state.error };
}

/** One lane's envelope/detail driver. Use this combined hook when switching
 * representations so an old physical RPC settles before its replacement. */
export function useWaveformPeaks(
  client: PeakClient | undefined,
  documentKey: object,
  params: PeaksGetParams | undefined,
  samples = false,
): SamplePeaksState {
  const channel = params?.channel;
  const startFrame = params?.startFrame;
  const endFrame = params?.endFrame;
  const buckets = params?.buckets;
  const request = useMemo<PeakRequest | undefined>(
    () =>
      client &&
      channel !== undefined &&
      startFrame !== undefined &&
      endFrame !== undefined &&
      buckets !== undefined
        ? { client, documentKey, params: { channel, startFrame, endFrame, buckets }, samples }
        : undefined,
    [client, documentKey, channel, startFrame, endFrame, buckets, samples],
  );
  const [snapshot, setSnapshot] = useState<PeakSnapshot>();
  const control = useRef<{
    active: boolean;
    sequence: number;
    latest: PeakRequest | undefined;
    inFlight: boolean;
    timer: ReturnType<typeof setTimeout> | undefined;
  }>({ active: false, sequence: 0, latest: undefined, inFlight: false, timer: undefined });

  useEffect(() => {
    const lane = control.current;
    // Old completed buffers must not stay retained after detail is disabled or
    // the viewport/document changes. Keep only the physical RPC occupied.
    setSnapshot(undefined);
    lane.active = true;
    lane.latest = request;
    lane.sequence++;

    function schedule() {
      if (!lane.active || !lane.latest || lane.inFlight || lane.timer !== undefined) return;
      // StrictMode can clean up its initial effect before issuing an RPC.
      lane.timer = setTimeout(() => {
        lane.timer = undefined;
        void refresh();
      }, 0);
    }

    async function refresh() {
      const target = lane.latest;
      if (!lane.active || !target || lane.inFlight) return;
      const sequence = lane.sequence;
      lane.inFlight = true;
      try {
        if (
          target.samples &&
          (!Number.isSafeInteger(target.params.startFrame) ||
            !Number.isSafeInteger(target.params.endFrame) ||
            target.params.startFrame < 0 ||
            target.params.endFrame <= target.params.startFrame ||
            target.params.endFrame - target.params.startFrame > MAX_SAMPLE_VIEW_FRAMES)
        )
          throw new Error("peaks.get: sample viewport exceeds a valid bounded frame range");
        const pages: PeakViews[] = [];
        let start = target.params.startFrame;
        do {
          // The addition remains JS-safe even at the final document frame.
          const end = target.samples
            ? start + Math.min(MAX_SAMPLE_PAGE_FRAMES, target.params.endFrame - start)
            : target.params.endFrame;
          const params = target.samples
            ? { ...target.params, startFrame: start, endFrame: end, buckets: end - start }
            : target.params;
          const response = await target.client.call("peaks.get", params);
          if (!lane.active || lane.sequence !== sequence || lane.latest !== target) return;
          const page = decodePeaks(response);
          if (target.samples) {
            if (response.framesPerBucket !== 1 || page.frameCounts.length !== end - start)
              throw new Error("peaks.get: sample detail requires exact one-frame buckets");
            for (let index = 0; index < page.frameCounts.length; index++) {
              if (page.frameCounts[index] !== 1 || page.startFrames[index] !== start + index)
                throw new Error("peaks.get: sample detail has missing or aggregate frames");
            }
          }
          pages.push(page);
          start = end;
        } while (target.samples && start < target.params.endFrame);
        setSnapshot({ request: target, pages, error: undefined });
      } catch (error) {
        if (lane.active && lane.sequence === sequence && lane.latest === target) {
          setSnapshot({
            request: target,
            pages: undefined,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        lane.inFlight = false;
        if (lane.sequence !== sequence || lane.latest !== target) schedule();
      }
    }

    schedule();
    return () => {
      lane.active = false;
      lane.latest = undefined;
      lane.sequence++;
      clearTimeout(lane.timer);
      lane.timer = undefined;
      // Keep the physical request occupied until its promise settles, even
      // when the viewport, document identity, or client changes.
    };
  }, [request]);

  // Compare the render's identity, so an old result cannot flash while waiting
  // for the replacement effect to run.
  const current = request && snapshot?.request === request ? snapshot : undefined;
  return {
    pages: current?.pages,
    loading: request !== undefined && current === undefined,
    error: current?.error,
  };
}
