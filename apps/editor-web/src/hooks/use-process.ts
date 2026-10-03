import type {
  DocumentInfoResult,
  EditResult,
  ProcessJobResult,
  SelectionRange,
} from "@aae/protocol";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { KernelClient } from "@/kernel/client";

export interface ProcessOptions {
  client?: KernelClient;
  info?: DocumentInfoResult;
  busy?: boolean;
  withOperation(work: () => Promise<void>): Promise<void>;
  beforeEdit(): Promise<void>;
  preparePreview(info: DocumentInfoResult): Promise<void>;
  playPreview(info: DocumentInfoResult, job: ProcessJobResult): Promise<void>;
  stopPreview(): Promise<void>;
  onEdited(result: EditResult, sourceDocumentId: string): void;
  onError(action: string, error: unknown): void;
}

export type ProcessPhase = "idle" | "processing" | "ready" | "committing" | "cancelling";
export interface ProcessView {
  info: DocumentInfoResult;
  selection: SelectionRange;
  gainText: string;
  phase: ProcessPhase;
  job?: ProcessJobResult;
  previewing: boolean;
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface Session {
  client: KernelClient;
  info: DocumentInfoResult;
  selection: SelectionRange;
  gainText: string;
  acquired: ReturnType<typeof deferred>;
  done: ReturnType<typeof deferred>;
  released: ReturnType<typeof deferred>;
  job?: ProcessJobResult;
  pending?: Promise<void>;
  cancellation?: Promise<void>;
  closing: boolean;
  committing: boolean;
  committed: boolean;
  previewing: boolean;
  stopPreview(): Promise<void>;
}

export function parseGain(text: string): number | undefined {
  if (!text.trim()) return;
  const value = Number(text);
  return Number.isFinite(value) && value >= -120 && value <= 60 ? value : undefined;
}

/** Own a shared document lock until a candidate is committed or discarded. */
export function useProcess(options: ProcessOptions) {
  const latest = useRef(options);
  latest.current = options;
  const mounted = useRef(false);
  const session = useRef<Session | undefined>(undefined);
  const [view, setView] = useState<ProcessView>();
  const owns = useCallback(
    (s: Session) =>
      mounted.current &&
      session.current === s &&
      latest.current.client === s.client &&
      latest.current.info?.documentId === s.info.documentId,
    [],
  );
  const update = useCallback(
    (s: Session, change: Partial<ProcessView>) => {
      if (owns(s)) setView((previous) => (previous ? { ...previous, ...change } : previous));
    },
    [owns],
  );
  const report = useCallback(
    (s: Session, error: unknown) => {
      if (owns(s)) latest.current.onError("Could not process audio", error);
    },
    [owns],
  );
  const finish = useCallback(async (s: Session) => {
    if (session.current === s) {
      session.current = undefined;
      if (mounted.current) setView(undefined);
    }
    s.done.resolve();
    await s.released.promise;
  }, []);
  const discard = useCallback(async (s: Session) => {
    const job = s.job;
    if (!job || job.state === "cancelled") return;
    s.job = await s.client.call("process.cancel", {
      documentId: s.info.documentId,
      jobId: job.jobId,
    });
  }, []);

  const cancel = useCallback(async () => {
    const s = session.current;
    // Once commit has been sent, a successful authoritative reply must win.
    if (!s || s.committing || s.cancellation) return s?.cancellation;
    s.closing = true;
    update(s, { phase: "cancelling" });
    s.cancellation = (async () => {
      try {
        // Send cancellation immediately, even while runProcess is awaiting its
        // terminal reply. The worker yields between its bounded Go calls.
        await discard(s);
      } catch (error) {
        report(s, error);
      }
      await s.pending?.catch(() => {});
      try {
        if (s.previewing) await s.stopPreview();
        await discard(s); // start may have replied after the first cancellation.
      } catch (error) {
        report(s, error);
      }
      s.previewing = false;
      await finish(s);
    })();
    return s.cancellation;
  }, [update, discard, report, finish]);

  useLayoutEffect(() => {
    const client = options.client;
    const documentId = options.info?.documentId;
    mounted.current = true;
    return () => {
      mounted.current = false;
      const s = session.current;
      if (s && !s.committed && s.client === client && s.info.documentId === documentId)
        void cancel();
    };
  }, [options.client, options.info?.documentId, cancel]);

  const open = useCallback(
    (selection: SelectionRange) => {
      const initial = latest.current;
      const { client, info } = initial;
      if (!mounted.current || !client || !info || initial.busy || session.current || !info.frames)
        return;
      const range =
        selection.start === selection.end
          ? { ...selection, start: 0, end: info.frames }
          : { ...selection };
      const s: Session = {
        client,
        info,
        selection: { ...selection },
        gainText: "0",
        acquired: deferred(),
        done: deferred(),
        released: deferred(),
        closing: false,
        committing: false,
        committed: false,
        previewing: false,
        stopPreview: initial.stopPreview,
      };
      session.current = s;
      setView({ info, selection: range, gainText: "0", phase: "idle", previewing: false });
      void initial
        .withOperation(async () => {
          s.acquired.resolve();
          await s.done.promise;
        })
        .catch((error) => {
          report(s, error);
          s.closing = true;
          s.acquired.resolve();
          if (session.current === s) {
            session.current = undefined;
            if (mounted.current) setView(undefined);
          }
        })
        .finally(() => s.released.resolve());
    },
    [report],
  );

  const setGainText = useCallback(
    (gainText: string) => {
      const s = session.current;
      if (!s || s.closing || s.pending || s.committing) return;
      s.gainText = gainText;
      update(s, { gainText });
    },
    [update],
  );

  const run = useCallback(
    (mode: "preview" | "apply", allowClipping = false) => {
      const s = session.current;
      if (!s || s.closing || s.pending || s.committing) return;
      const gainDb = parseGain(s.gainText);
      if (gainDb === undefined) return;
      // Invoke before the first await: AudioContext activation belongs to this
      // button gesture, not to the eventual job-completion task.
      let preparation: Promise<void>;
      try {
        preparation =
          mode === "preview" ? latest.current.preparePreview(s.info) : Promise.resolve();
      } catch (error) {
        report(s, error);
        return;
      }
      void preparation.catch(() => {});
      update(s, { phase: "processing" });
      const work = async () => {
        try {
          await s.acquired.promise;
          await preparation;
          if (s.closing || !owns(s)) return;
          await latest.current.beforeEdit();
          if (s.closing || !owns(s)) return;
          s.previewing = false;
          update(s, { previewing: false });
          if (s.job?.state !== "ready" || s.job.gainDb !== gainDb) {
            await discard(s);
            if (s.closing || !owns(s)) return;
            s.job = await s.client.call("process.start", {
              documentId: s.info.documentId,
              ...s.selection,
              operation: "gain",
              gainDb,
            });
            if (s.closing || !owns(s)) {
              await discard(s);
              return;
            }
            update(s, { job: s.job });
            s.job = await s.client.runProcess(
              { documentId: s.info.documentId, jobId: s.job.jobId },
              (job) => {
                if (job.jobId !== s.job?.jobId || job.documentId !== s.info.documentId) return;
                if (!s.closing) update(s, { job });
              },
            );
          }
          if (s.closing || !owns(s)) return;
          if (s.job.state !== "ready") {
            s.job = undefined;
            update(s, { phase: "idle", job: undefined });
            return;
          }
          update(s, { phase: "ready", job: s.job });
          if (mode === "preview") {
            s.previewing = true;
            await latest.current.playPreview(s.info, s.job);
            if (!s.closing) update(s, { previewing: true });
            return;
          }
          if ((s.job.peak > 1 || s.job.nonFinite) && !allowClipping) return;
          s.committing = true;
          update(s, { phase: "committing" });
          const result = await s.client.call("process.commit", {
            documentId: s.info.documentId,
            jobId: s.job.jobId,
          });
          s.committed = true;
          s.job = undefined;
          if (owns(s)) latest.current.onEdited(result, s.info.documentId);
          await finish(s);
        } catch (error) {
          report(s, error);
          try {
            if (s.previewing) await s.stopPreview();
            await discard(s);
          } catch (cleanupError) {
            report(s, cleanupError);
          }
          s.job = undefined;
          s.previewing = false;
          // Cleanup cannot interrupt an authoritative commit. If it rejects
          // after ownership changed, release the old session here instead of
          // leaving its modal/document fence held on the replacement client.
          if (s.committed || !owns(s)) await finish(s);
          else if (!s.closing) update(s, { phase: "idle", job: undefined, previewing: false });
        } finally {
          s.committing = false;
          s.pending = undefined;
        }
      };
      s.pending = work();
      return s.pending;
    },
    [owns, update, report, discard, finish],
  );

  const stopPreview = useCallback(() => {
    const s = session.current;
    if (!s || s.pending || s.closing || !s.previewing) return;
    update(s, { phase: "processing" });
    s.pending = (async () => {
      try {
        await s.stopPreview();
        s.previewing = false;
        update(s, { previewing: false });
      } catch (error) {
        report(s, error);
      } finally {
        s.pending = undefined;
        if (!s.closing) update(s, { phase: "ready" });
      }
    })();
    return s.pending;
  }, [update, report]);

  return {
    view,
    open,
    setGainText,
    preview: () => run("preview"),
    apply: (allowClipping = false) => run("apply", allowClipping),
    stopPreview,
    cancel,
  };
}
