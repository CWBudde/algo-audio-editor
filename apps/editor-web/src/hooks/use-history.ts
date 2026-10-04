import type { DocumentInfoResult, EditResult, HistoryListResult } from "@aae/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { useKernelSession } from "@/hooks/use-kernel-session";
import type { KernelClient } from "@/kernel/client";

export interface HistoryOptions {
  client: KernelClient | undefined;
  info: DocumentInfoResult | undefined;
  busy?: boolean;
  withOperation?(work: () => Promise<void>): Promise<void>;
  beforeEdit(): Promise<void>;
  onEdited(result: EditResult, sourceDocumentId: string): void;
  refreshDocument?(client: KernelClient): Promise<void>;
  onError(action: string, error: unknown): void;
}

interface Snapshot {
  client: KernelClient;
  value: HistoryListResult;
}

/** Kernel snapshots own history; this hook only serializes navigation controls. */
export function useHistory(options: HistoryOptions) {
  const {
    latest,
    mounted,
    token: operation,
    capture,
  } = useKernelSession<HistoryOptions, object>(options, options.client, options.info, undefined);
  const revision = useRef(0);
  const snapshot = useRef<Snapshot | undefined>(undefined);
  const [state, setState] = useState<Snapshot>();
  const [busy, setBusy] = useState(false);

  const publish = useCallback((client: KernelClient, value: HistoryListResult) => {
    if (snapshot.current?.client === client && snapshot.current.value === value) return;
    revision.current++;
    snapshot.current = { client, value };
    setState(snapshot.current);
  }, []);

  // An edit can publish its new identity before React commits the new info.
  // Callers must only accept their guarded edit/save response for this client.
  const accept = useCallback(
    (value: HistoryListResult) => {
      const client = latest.current.client;
      if (mounted.current && client) publish(client, value);
    },
    [publish, latest, mounted],
  );

  useEffect(() => {
    const client = options.client;
    const info = options.info;
    if (!client || !info) return;
    let active = true;
    const started = revision.current;
    void client.call("history.list", { documentId: info.documentId }).then(
      (value) => {
        if (
          active &&
          latest.current.client === client &&
          latest.current.info === info &&
          revision.current === started &&
          value.documentId === info.documentId
        )
          publish(client, value);
      },
      (error: unknown) => {
        if (
          active &&
          latest.current.client === client &&
          latest.current.info === info &&
          revision.current === started
        )
          latest.current.onError("Could not read edit history", error);
      },
    );
    return () => {
      active = false;
    };
  }, [options.client, options.info, publish, latest]);

  const navigate = useCallback(
    async (kind: "undo" | "redo" | "jump", stateId?: string) => {
      const initial = latest.current;
      const { client, info } = initial;
      const current = snapshot.current;
      if (
        !mounted.current ||
        !client ||
        !info ||
        initial.busy ||
        operation.current ||
        current?.client !== client ||
        current.value.documentId !== info.documentId
      )
        return;
      const history = current.value;
      if (kind === "undo" && !history.canUndo) return;
      if (kind === "redo" && !history.canRedo) return;
      if (
        kind === "jump" &&
        (!stateId ||
          stateId === history.currentStateId ||
          !history.entries.some((entry) => entry.stateId === stateId))
      )
        return;
      const token = {};
      const sourceDocumentId = info.documentId;
      operation.current = token;
      setBusy(true);
      const active = capture(token);
      const work = async () => {
        if (!active()) return;
        await latest.current.beforeEdit();
        if (!active()) return;
        const result =
          kind === "jump"
            ? await client.call("history.jump", {
                documentId: sourceDocumentId,
                stateId: stateId ?? "",
              })
            : await client.call(kind === "undo" ? "edit.undo" : "edit.redo", {
                documentId: sourceDocumentId,
              });
        if (!active()) {
          if (mounted.current && latest.current.client === client)
            await latest.current.refreshDocument?.(client);
          return;
        }
        publish(client, result.history);
        latest.current.onEdited(result, sourceDocumentId);
      };
      try {
        if (initial.withOperation) await initial.withOperation(work);
        else await work();
      } catch (error) {
        if (active()) latest.current.onError(`Could not ${kind} edit history`, error);
      } finally {
        if (operation.current === token) operation.current = undefined;
        if (mounted.current) setBusy(false);
      }
    },
    [publish, capture, latest, mounted, operation],
  );

  const undo = useCallback(() => navigate("undo"), [navigate]);
  const redo = useCallback(() => navigate("redo"), [navigate]);
  const jump = useCallback((stateId: string) => navigate("jump", stateId), [navigate]);
  return {
    busy,
    history:
      state &&
      state.client === options.client &&
      state.value.documentId === options.info?.documentId
        ? state.value
        : undefined,
    accept,
    undo,
    redo,
    jump,
  };
}
