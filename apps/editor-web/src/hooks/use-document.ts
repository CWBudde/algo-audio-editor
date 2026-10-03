import type { DocumentInfoResult, HistoryListResult } from "@aae/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { KernelClient } from "@/kernel/client";
import { chooseAudioFile, chooseSaveTarget, isFileDialogCancelled } from "@/lib/file-access";

interface DocumentOptions {
  beforeOpen(): Promise<void>;
  fallbackOpen(): void;
  reportError(action: string, error: unknown): void;
  onSaved?(history: HistoryListResult): void;
}

/** Owns document revisions and serializes file and edit workflows. */
export function useDocument(client: KernelClient | undefined, options: DocumentOptions) {
  const latest = useRef({ client, options });
  latest.current = { client, options };
  const operation = useRef<object | undefined>(undefined);
  const generation = useRef(0);
  const mounted = useRef(false);
  const [snapshot, setSnapshot] = useState<{ client: KernelClient; info: DocumentInfoResult }>();
  const [pending, setPending] = useState<{ client: KernelClient; busy: boolean }>();
  const currentInfo = useRef<DocumentInfoResult | undefined>(undefined);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    const startedWith = generation.current;
    client?.call("doc.info").then(
      (info) => {
        if (active && client && generation.current === startedWith) setSnapshot({ client, info });
      },
      () => undefined,
    );
    return () => {
      active = false;
      mounted.current = false;
      operation.current = undefined;
      generation.current++;
    };
  }, [client]);

  const run = useCallback(
    (action: string, work: (target: KernelClient, active: () => boolean) => Promise<void>) => {
      const target = latest.current.client;
      if (!target || operation.current) return;
      const token = {};
      generation.current++;
      operation.current = token;
      setPending({ client: target, busy: true });
      const active = () =>
        mounted.current && latest.current.client === target && operation.current === token;
      void work(target, active)
        .catch((error: unknown) => {
          if (active() && !isFileDialogCancelled(error))
            latest.current.options.reportError(action, error);
        })
        .finally(() => {
          if (active()) setPending({ client: target, busy: false });
          if (operation.current === token) operation.current = undefined;
        });
    },
    [],
  );

  const importFile = useCallback(
    async (target: KernelClient, active: () => boolean, file: File) => {
      const stopping = latest.current.options.beforeOpen();
      // Reading does not mutate the document and can overlap playback shutdown.
      // Settle both before releasing the operation lock, even if either fails.
      const [stopped, reading] = await Promise.allSettled([
        stopping,
        Promise.resolve().then(() => file.arrayBuffer()),
      ]);
      if (!active()) return;
      if (stopped.status === "rejected") throw stopped.reason;
      if (reading.status === "rejected") throw reading.reason;
      const info = await target.openDocument(file.name, reading.value);
      if (active()) setSnapshot({ client: target, info });
    },
    [],
  );

  const openFile = useCallback(
    (file: File) => {
      run("Could not open audio", (target, active) => importFile(target, active, file));
    },
    [importFile, run],
  );

  const open = useCallback(() => {
    run("Could not open audio", async (target, active) => {
      const file = await chooseAudioFile(() => {
        if (active()) latest.current.options.fallbackOpen();
      });
      if (file && active()) await importFile(target, active, file);
    });
  }, [importFile, run]);

  const info = snapshot?.client === client ? snapshot?.info : undefined;
  currentInfo.current = info;
  /** Edits share the file-operation lock, including preparation and confirmation. */
  const withOperation = useCallback(async (work: () => Promise<void>) => {
    const target = latest.current.client;
    if (!target || !mounted.current) throw new Error("The audio document is unavailable.");
    if (operation.current) throw new Error("Another document operation is in progress.");
    const token = {};
    generation.current++;
    operation.current = token;
    setPending({ client: target, busy: true });
    try {
      await work();
    } finally {
      if (mounted.current && latest.current.client === target && operation.current === token)
        setPending({ client: target, busy: false });
      if (operation.current === token) operation.current = undefined;
    }
  }, []);
  const replaceInfo = useCallback((next: DocumentInfoResult, expectedDocumentId: string) => {
    const target = latest.current.client;
    if (!mounted.current || !target || currentInfo.current?.documentId !== expectedDocumentId)
      return;
    generation.current++;
    currentInfo.current = next;
    setSnapshot({ client: target, info: next });
  }, []);
  const save = useCallback(() => {
    if (!info || latest.current.client !== client) return;
    run("Could not save audio", async (target, active) => {
      const destination = await chooseSaveTarget(info.name);
      if (!destination || !active()) return;
      const history = await target.call("history.list", { documentId: info.documentId });
      if (!active()) return;
      const result = await target.call("doc.export", {
        format: "wav",
        bitDepth: info.bitDepth,
        float: info.float,
      });
      if (!active()) return;
      await destination.write(result);
      if (!active()) return;
      // Exporting does not save: only acknowledge the exact state after a
      // successful destination write, still under the shared operation lock.
      const saved = await target.call("doc.mark-saved", {
        documentId: info.documentId,
        stateId: history.currentStateId,
      });
      if (active()) latest.current.options.onSaved?.(saved);
    });
  }, [client, info, run]);

  return {
    info,
    busy: pending?.client === client && pending?.busy === true,
    open,
    openFile,
    save,
    withOperation,
    replaceInfo,
  };
}
