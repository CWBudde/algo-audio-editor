import type { DocumentInfoResult } from "@aae/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { KernelClient } from "@/kernel/client";
import { chooseAudioFile, chooseSaveTarget, isFileDialogCancelled } from "@/lib/file-access";

interface DocumentOptions {
  beforeOpen(): Promise<void>;
  fallbackOpen(): void;
  reportError(action: string, error: unknown): void;
}

/** Owns file operations; only one picker/import/export may be active at a time. */
export function useDocument(client: KernelClient | undefined, options: DocumentOptions) {
  const latest = useRef({ client, options });
  latest.current = { client, options };
  const operation = useRef<object | undefined>(undefined);
  const generation = useRef(0);
  const mounted = useRef(false);
  const [snapshot, setSnapshot] = useState<{ client: KernelClient; info: DocumentInfoResult }>();
  const [pending, setPending] = useState<{ client: KernelClient; busy: boolean }>();

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
      await latest.current.options.beforeOpen();
      if (!active()) return;
      const bytes = await file.arrayBuffer();
      if (!active()) return;
      const info = await target.openDocument(file.name, bytes);
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
  const save = useCallback(() => {
    if (!info || latest.current.client !== client) return;
    run("Could not save audio", async (target, active) => {
      const destination = await chooseSaveTarget(info.name);
      if (!destination || !active()) return;
      const result = await target.call("doc.export", {
        format: "wav",
        bitDepth: info.bitDepth,
        float: info.float,
      });
      if (active()) await destination.write(result);
    });
  }, [client, info, run]);

  return { info, busy: pending?.client === client && pending?.busy === true, open, openFile, save };
}
