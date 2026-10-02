import type { PeaksGetParams } from "@aae/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KernelClient } from "@/kernel/client";
import { decodePeaks, type PeakViews } from "@/kernel/peak-data";

type PeakClient = Pick<KernelClient, "call">;

interface PeakRequest {
  client: PeakClient;
  documentKey: object;
  params: PeaksGetParams;
}

interface PeakSnapshot {
  request: PeakRequest;
  data: PeakViews | undefined;
  error: string | undefined;
}

export interface PeaksState {
  data: PeakViews | undefined;
  loading: boolean;
  error: string | undefined;
}

/** Request kernel-computed peaks, keeping one RPC and only the latest pending viewport. */
export function usePeaks(
  client: PeakClient | undefined,
  documentKey: object,
  params: PeaksGetParams | undefined,
): PeaksState {
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
        ? { client, documentKey, params: { channel, startFrame, endFrame, buckets } }
        : undefined,
    [client, documentKey, channel, startFrame, endFrame, buckets],
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
        const response = await target.client.call("peaks.get", target.params);
        if (lane.active && lane.sequence === sequence && lane.latest === target) {
          setSnapshot({ request: target, data: decodePeaks(response), error: undefined });
        }
      } catch (error) {
        if (lane.active && lane.sequence === sequence && lane.latest === target) {
          setSnapshot({
            request: target,
            data: undefined,
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
    data: current?.data,
    loading: request !== undefined && current === undefined,
    error: current?.error,
  };
}
