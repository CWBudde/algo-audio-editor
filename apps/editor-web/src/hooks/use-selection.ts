import type { DocumentInfoResult, SelectionRange, TimelineResult } from "@aae/protocol";
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

/** Optimistic control state; audio analysis and authoritative state stay in Go. */
export function useSelection(client: KernelClient | undefined, info: DocumentInfoResult) {
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  const session = useMemo<Session>(() => {
    const selection = { start: 0, end: 0, channelMask: (1 << info.channels) - 1 };
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
      timeline: { documentId: info.documentId, markers: [], regions: [] },
      timelineRevision: 0,
      adding: false,
    };
  }, [client, info]);
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
        target.acknowledged = write.selection;
        target.acknowledgedRevision = write.revision;
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
            session.acknowledgedRevision !== 0
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
          if (!current() || session.commits !== 0) return;
          session.error = error instanceof Error ? error.message : String(error);
          refresh();
        },
      );
      void client.call("timeline.get", { documentId: info.documentId }).then(
        (result) => {
          if (!current() || result.documentId !== info.documentId || session.timelineRevision)
            return;
          session.timeline = result;
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
  const addAnchor = useCallback(
    async (kind: "marker" | "region", name: string) => {
      if (!session.active || session.adding || !client) return;
      session.adding = true;
      session.error = undefined;
      refresh();
      try {
        const { start, end } = session.selection;
        const result =
          kind === "marker"
            ? await client.call("markers.add", { documentId: info.documentId, frame: start, name })
            : await client.call("regions.add", { documentId: info.documentId, start, end, name });
        if (session.active && result.documentId === info.documentId) {
          session.timelineRevision++;
          session.timeline = result;
        }
      } catch (error) {
        if (session.active) session.error = error instanceof Error ? error.message : String(error);
      } finally {
        session.adding = false;
        if (session.active) refresh();
      }
    },
    [client, info, session],
  );

  return {
    selection: session.selection,
    timeline: session.timeline,
    adding: session.adding,
    error: session.error,
    preview,
    cancelPreview,
    commit,
    snap,
    addAnchor,
  };
}
