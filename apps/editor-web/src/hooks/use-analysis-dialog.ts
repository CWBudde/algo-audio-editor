import type {
  AnalysisJobResult,
  AnalysisKind,
  DocumentInfoResult,
  EditResult,
  SelectionRange,
} from "@aae/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { analyse, releaseAnalysis } from "@/kernel/analysis-queue";
import type { KernelClient } from "@/kernel/client";
export interface AnalysisView {
  info: DocumentInfoResult;
  selection: SelectionRange;
  kind: AnalysisKind;
  job?: AnalysisJobResult;
  working: boolean;
  committing: boolean;
  error?: string;
}
export function useAnalysisDialog(options: {
  client?: KernelClient;
  info?: DocumentInfoResult;
  busy: boolean;
  stateId?: string;
  beforeEdit(): Promise<void>;
  withOperation(work: () => Promise<void>): Promise<void>;
  onEdited(result: EditResult, id: string): void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const [view, setView] = useState<AnalysisView>();
  const session = useRef<
    | {
        client: KernelClient;
        info: DocumentInfoResult;
        controller: AbortController;
        job?: AnalysisJobResult;
        committing: boolean;
        invalidated: boolean;
        beforeEdit: typeof options.beforeEdit;
        withOperation: typeof options.withOperation;
        onEdited: typeof options.onEdited;
        stateId?: string;
      }
    | undefined
  >(undefined);
  const cancel = useCallback(() => {
    const s = session.current;
    if (!s || s.committing) return;
    session.current = undefined;
    s.controller.abort();
    if (s.job) {
      const job = s.job;
      void s.client
        .call("analysis.cancel", { documentId: job.documentId, jobId: job.jobId })
        .catch(() => {})
        .finally(() => releaseAnalysis(s.client, job.jobId));
    }
    setView(undefined);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: captured document/history identity owns the modal and its cancellation.
  useEffect(
    () => () => {
      if (session.current) session.current.invalidated = true;
      cancel();
    },
    [options.client, options.info?.documentId, options.stateId, cancel],
  );
  const open = useCallback(
    (kind: AnalysisKind, selection: SelectionRange) => {
      const { client, info, busy } = latest.current;
      if (!client || !info || busy || !info.frames) return;
      cancel();
      const s = {
        client,
        info,
        controller: new AbortController(),
        job: undefined as AnalysisJobResult | undefined,
        committing: false,
        invalidated: false,
        beforeEdit: latest.current.beforeEdit,
        withOperation: latest.current.withOperation,
        onEdited: latest.current.onEdited,
        stateId: latest.current.stateId,
      };
      session.current = s;
      setView({ info, selection, kind, working: true, committing: false });
      void analyse(
        client,
        { documentId: info.documentId, ...selection, kind, fftSize: 2048, hopSize: 512 },
        s.controller.signal,
        (job) => {
          if (session.current === s) setView((v) => (v ? { ...v, job } : v));
        },
      ).then(
        (job) => {
          s.job = job;
          if (session.current === s) setView((v) => (v ? { ...v, job, working: false } : v));
          else if (kind === "clipping")
            void client
              .call("analysis.cancel", { documentId: job.documentId, jobId: job.jobId })
              .catch(() => {})
              .finally(() => releaseAnalysis(client, job.jobId));
        },
        (error: unknown) => {
          if (session.current === s)
            setView((v) =>
              v
                ? {
                    ...v,
                    working: false,
                    error: error instanceof Error ? error.message : String(error),
                  }
                : v,
            );
        },
      );
    },
    [cancel],
  );
  const commit = useCallback(async () => {
    const s = session.current;
    if (
      !s?.job ||
      s.committing ||
      s.job.kind !== "clipping" ||
      s.job.state !== "ready" ||
      latest.current.info?.documentId !== s.info.documentId
    )
      return;
    const job = s.job;
    s.committing = true;
    setView((v) => (v ? { ...v, working: true, committing: true, error: undefined } : v));
    try {
      await s.withOperation(async () => {
        await s.beforeEdit();
        if (
          s.invalidated ||
          session.current !== s ||
          latest.current.client !== s.client ||
          latest.current.info?.documentId !== s.info.documentId ||
          latest.current.stateId !== s.stateId
        )
          throw new Error("Document changed during analysis");
        const result = await s.client.call("analysis.commit", {
          documentId: job.documentId,
          jobId: job.jobId,
        });
        releaseAnalysis(s.client, job.jobId);
        if (
          latest.current.client === s.client &&
          latest.current.info?.documentId === s.info.documentId
        )
          s.onEdited(result, s.info.documentId);
      });
      if (session.current === s) {
        session.current = undefined;
        setView(undefined);
      }
    } catch (error) {
      if (session.current === s)
        setView((v) =>
          v
            ? {
                ...v,
                working: false,
                committing: false,
                error: error instanceof Error ? error.message : String(error),
              }
            : v,
        );
    } finally {
      s.committing = false;
      if (s.invalidated && session.current === s) cancel();
    }
  }, [cancel]);
  return { view, open, cancel, commit };
}
