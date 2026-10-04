import type { DocumentInfoResult, HistoryListResult, MetadataResult } from "@aae/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { KernelClient } from "@/kernel/client";

export interface MetadataView {
  name: string;
  metadata?: MetadataResult;
  working: boolean;
  committing: boolean;
  error?: string;
}
interface Options {
  client?: KernelClient;
  info?: DocumentInfoResult;
  stateId?: string;
  busy: boolean;
  withOperation(work: () => Promise<void>): Promise<void>;
  onChanged(history: HistoryListResult): void;
}
export function useMetadata(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const [view, setView] = useState<MetadataView>();
  const session = useRef<
    | {
        client: KernelClient;
        id: string;
        stateId?: string;
        metadata?: MetadataResult;
        committing: boolean;
      }
    | undefined
  >(undefined);
  const cancel = useCallback(() => {
    if (session.current?.committing) return;
    session.current = undefined;
    setView(undefined);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: document/history replacement invalidates a captured draft.
  useEffect(
    () => () => {
      session.current = undefined;
      setView(undefined);
    },
    [options.client, options.info?.documentId, options.stateId],
  );
  const open = useCallback(() => {
    const { client, info, busy, stateId } = latest.current;
    if (!client || !info || busy || session.current) return;
    const s = {
      client,
      id: info.documentId,
      stateId,
      committing: false,
      metadata: undefined as MetadataResult | undefined,
    };
    session.current = s;
    setView({ name: info.name, working: true, committing: false });
    void client
      .call("metadata.get", { documentId: s.id })
      .then((metadata) => {
        if (session.current !== s) return;
        if (metadata.documentId !== s.id || (s.stateId && metadata.stateId !== s.stateId))
          throw new Error("Document changed while reading metadata");
        s.metadata = metadata;
        setView({ name: info.name, metadata, working: false, committing: false });
      })
      .catch((error: unknown) => {
        if (session.current === s)
          setView({
            name: info.name,
            working: false,
            committing: false,
            error: error instanceof Error ? error.message : String(error),
          });
      });
  }, []);
  const commit = useCallback(async (tags: Record<string, string>) => {
    const s = session.current;
    if (!s?.metadata || s.committing || latest.current.busy) return;
    const current = () =>
      session.current === s &&
      latest.current.client === s.client &&
      latest.current.info?.documentId === s.id &&
      latest.current.stateId === s.stateId;
    s.committing = true;
    setView((v) => (v ? { ...v, working: true, committing: true, error: undefined } : v));
    try {
      await latest.current.withOperation(async () => {
        if (!current()) throw new Error("Document changed while editing metadata");
        const result = await s.client.call("metadata.set", {
          documentId: s.id,
          stateId: s.metadata?.stateId ?? "",
          tags,
        });
        if (current()) latest.current.onChanged(result.history);
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
    }
  }, []);
  return { view, open, cancel, commit };
}
