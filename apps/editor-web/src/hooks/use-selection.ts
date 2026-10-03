import type {
  DocumentInfoResult,
  EditResult,
  MarkerUpdateParams,
  RegionUpdateParams,
  SelectionRange,
  TimelineMutationResult,
  TimelineResult,
} from "@aae/protocol";
import { useCallback, useLayoutEffect, useMemo, useReducer, useRef } from "react";
import type { KernelClient } from "@/kernel/client";

interface Session {
  client: KernelClient | undefined;
  info: DocumentInfoResult;
  active: boolean;
  epoch: number;
  revision: number;
  commitRevision: number;
  commits: number;
  previewing: boolean;
  selection: SelectionRange;
  committed: SelectionRange;
  acknowledged: SelectionRange;
  acknowledgedRevision: number;
  metadataAcknowledged?: boolean;
  rejectedRevision?: number;
  timeline: TimelineResult;
  timelineRevision: number;
  adding: boolean;
  error?: string;
}

interface Write {
  session: Session;
  selection: SelectionRange;
  revision: number;
}

export interface SelectionOptions {
  busy?: boolean;
  withOperation?: (work: () => Promise<void>) => Promise<void>;
  onTimelineChanged?: (result: TimelineMutationResult, sourceDocumentId: string) => void;
}

type MarkerChanges = Omit<MarkerUpdateParams, "documentId" | "selection">;
type RegionChanges = Omit<RegionUpdateParams, "documentId" | "selection">;

/** Optimistic control state; audio analysis and authoritative state stay in Go. */
export function useSelection(
  client: KernelClient | undefined,
  info: DocumentInfoResult,
  initial?: Pick<EditResult, "selection" | "timeline">,
  options: SelectionOptions = {},
) {
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  const session = useMemo<Session>(() => {
    const seed =
      initial?.selection.documentId === info.documentId &&
      initial.timeline.documentId === info.documentId
        ? initial
        : undefined;
    const selection = seed
      ? {
          start: seed.selection.start,
          end: seed.selection.end,
          channelMask: seed.selection.channelMask,
        }
      : { start: 0, end: 0, channelMask: (1 << info.channels) - 1 };
    return {
      client,
      info,
      active: false,
      epoch: 0,
      revision: 0,
      commitRevision: 0,
      commits: 0,
      previewing: false,
      selection,
      committed: selection,
      acknowledged: selection,
      acknowledgedRevision: 0,
      timeline: seed?.timeline ?? { documentId: info.documentId, markers: [], regions: [] },
      timelineRevision: 0,
      adding: false,
    };
  }, [client, info, initial]);
  const latestOptions = useRef(options);
  latestOptions.current = options;
  const currentSession = useRef(session);
  currentSession.current = session;
  const mutation = useRef<object | undefined>(undefined);
  // One physical write at a time, with only the newest pending range retained.
  // A replacement session cannot let the old response paint its UI; the kernel
  // additionally rejects writes carrying an obsolete document ID.
  const lane = useRef<{ inFlight: boolean; pending?: Write }>({ inFlight: false });
  const drain = useCallback(function drain() {
    const write = lane.current.pending;
    if (lane.current.inFlight || !write) return;
    lane.current.pending = undefined;
    const target = write.session;
    if (!target.active || !target.client) return;
    lane.current.inFlight = true;
    void target.client
      .call("selection.set", { documentId: target.info.documentId, ...write.selection })
      .then((result) => {
        if (!target.active || result.documentId !== target.info.documentId) return;
        if (write.revision >= target.acknowledgedRevision) {
          target.acknowledged = write.selection;
          target.acknowledgedRevision = write.revision;
        }
        if (target.commitRevision === write.revision) target.error = undefined;
      })
      .catch((error: unknown) => {
        if (!target.active || target.commitRevision !== write.revision) return;
        target.committed = target.acknowledged;
        target.rejectedRevision = write.revision;
        if (!target.previewing) target.selection = target.acknowledged;
        target.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        lane.current.inFlight = false;
        if (target.active) refresh();
        drain();
      });
  }, []);

  useLayoutEffect(() => {
    session.active = true;
    const epoch = ++session.epoch;
    const current = () => session.active && session.epoch === epoch;
    if (client) {
      void client.call("selection.get", { documentId: info.documentId }).then(
        (result) => {
          if (
            !current() ||
            result.documentId !== info.documentId ||
            session.acknowledgedRevision !== 0 ||
            session.metadataAcknowledged
          )
            return;
          const { start, end, channelMask } = result;
          session.acknowledged = { start, end, channelMask };
          if (session.commits === 0 || session.rejectedRevision === session.commitRevision) {
            session.committed = session.acknowledged;
            if (!session.previewing) session.selection = session.acknowledged;
          }
          refresh();
        },
        (error: unknown) => {
          if (!current() || session.commits !== 0 || session.metadataAcknowledged) return;
          session.error = error instanceof Error ? error.message : String(error);
          refresh();
        },
      );
      void client.call("timeline.get", { documentId: info.documentId }).then(
        (result) => {
          if (!current() || result.documentId !== info.documentId || session.timelineRevision)
            return;
          session.timeline = {
            documentId: result.documentId,
            markers: result.markers,
            regions: result.regions,
          };
          refresh();
        },
        (error: unknown) => {
          if (!current() || session.timelineRevision) return;
          session.error = error instanceof Error ? error.message : String(error);
          refresh();
        },
      );
    }
    drain();
    return () => {
      session.active = false;
      if (lane.current.pending?.session === session) lane.current.pending = undefined;
    };
  }, [client, info, session, drain]);

  const preview = useCallback(
    (selection: SelectionRange) => {
      if (!session.active) return;
      session.selection = selection;
      session.previewing = true;
      session.revision++;
      refresh();
    },
    [session],
  );
  const commit = useCallback(
    (selection: SelectionRange) => {
      if (!session.active) return;
      session.selection = selection;
      session.committed = selection;
      session.previewing = false;
      session.commitRevision = ++session.revision;
      session.commits++;
      session.rejectedRevision = undefined;
      session.error = undefined;
      lane.current.pending = { session, selection, revision: session.revision };
      refresh();
      drain();
    },
    [session, drain],
  );
  const cancelPreview = useCallback(() => {
    if (!session.active) return;
    session.previewing = false;
    session.selection = session.committed;
    session.revision++;
    refresh();
  }, [session]);
  const snap = useCallback(
    async (frame: number, radius: number, channelMask: number) => {
      if (!session.active || !client) return undefined;
      const revision = session.revision;
      try {
        const result = await client.call("selection.snap", {
          documentId: info.documentId,
          frame,
          radius,
          channelMask,
        });
        return session.active && result.documentId === info.documentId ? result : undefined;
      } catch (error) {
        if (session.active && session.revision === revision) {
          session.error = error instanceof Error ? error.message : String(error);
          refresh();
        }
        return undefined;
      }
    },
    [client, info, session],
  );
  const mutate = useCallback(
    async (
      request: (rpc: KernelClient, selection: SelectionRange) => Promise<TimelineMutationResult>,
    ) => {
      if (
        !session.active ||
        session.previewing ||
        mutation.current ||
        latestOptions.current.busy ||
        !client
      )
        return;
      const token = {};
      mutation.current = token;
      const epoch = session.epoch;
      const revision = session.commitRevision;
      const selection = { ...session.committed };
      const active = () =>
        session.active && session.epoch === epoch && currentSession.current === session;
      session.adding = true;
      session.error = undefined;
      refresh();
      try {
        const work = async () => {
          if (!active() || session.previewing || session.commitRevision !== revision) return;
          const result = await request(client, selection);
          if (!active() || result.documentId !== info.documentId) return;
          session.timelineRevision++;
          session.timeline = {
            documentId: result.documentId,
            markers: result.markers,
            regions: result.regions,
          };
          if (result.changed && revision >= session.acknowledgedRevision) {
            session.acknowledged = selection;
            session.acknowledgedRevision = revision;
            session.metadataAcknowledged = true;
            if (session.commitRevision === revision) {
              // A preceding SET may have failed while this atomic mutation was
              // pending. The successful metadata snapshot adopted these controls.
              session.committed = selection;
              if (!session.previewing) session.selection = selection;
              session.rejectedRevision = undefined;
              session.error = undefined;
            }
          }
          latestOptions.current.onTimelineChanged?.(result, info.documentId);
        };
        const wrapper = latestOptions.current.withOperation;
        if (wrapper) await wrapper(work);
        else await work();
      } catch (error) {
        if (active()) session.error = error instanceof Error ? error.message : String(error);
      } finally {
        session.adding = false;
        if (mutation.current === token) mutation.current = undefined;
        if (currentSession.current.active) refresh();
      }
    },
    [client, info, session],
  );
  const addAnchor = (kind: "marker" | "region", name: string, color = "#a78bfa") =>
    mutate((rpc, selection) =>
      kind === "marker"
        ? rpc.call("markers.add", {
            documentId: info.documentId,
            frame: selection.start,
            name,
            color,
            selection,
          })
        : rpc.call("regions.add", {
            documentId: info.documentId,
            start: selection.start,
            end: selection.end,
            name,
            color,
            selection,
          }),
    );
  const updateMarker = (changes: MarkerChanges) =>
    mutate((rpc, selection) =>
      rpc.call("markers.update", { documentId: info.documentId, ...changes, selection }),
    );
  const updateRegion = (changes: RegionChanges) =>
    mutate((rpc, selection) =>
      rpc.call("regions.update", { documentId: info.documentId, ...changes, selection }),
    );
  const removeMarker = (id: number) =>
    mutate((rpc, selection) =>
      rpc.call("markers.remove", { documentId: info.documentId, id, selection }),
    );
  const removeRegion = (id: number) =>
    mutate((rpc, selection) =>
      rpc.call("regions.remove", { documentId: info.documentId, id, selection }),
    );

  return {
    selection: session.selection,
    previewing: session.previewing,
    timeline: session.timeline,
    adding: Boolean(mutation.current),
    error: session.error,
    preview,
    cancelPreview,
    commit,
    snap,
    addAnchor,
    updateMarker,
    updateRegion,
    removeMarker,
    removeRegion,
  };
}
