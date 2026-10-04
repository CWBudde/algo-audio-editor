import type { DocumentInfoResult, HistoryListResult, TimelineExportParams } from "@aae/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { useKernelSession } from "@/hooks/use-kernel-session";
import type { KernelClient } from "@/kernel/client";
import { openAudioDocument } from "@/lib/audio-codecs";
import {
  defaultExportSettings,
  exportFileTypes,
  exportName,
  exportParams,
} from "@/lib/export-settings";
import {
  chooseAudioFile,
  chooseSaveTarget,
  finishNativeOpen,
  isFileDialogCancelled,
  readNativeFile,
} from "@/lib/file-access";
import { desktopBridge, type NativeFile } from "@/platform";

interface DocumentOptions {
  beforeOpen(): Promise<void>;
  fallbackOpen(): void;
  reportError(action: string, error: unknown): void;
  onSaved?(history: HistoryListResult): void;
}

/** Owns document revisions and serializes file and edit workflows. */
export function useDocument(client: KernelClient | undefined, options: DocumentOptions) {
  const {
    latest,
    mounted,
    token: operation,
    capture,
  } = useKernelSession({ client, options }, client, client, () => {
    operation.current = undefined;
    generation.current++;
  });
  const generation = useRef(0);
  const [snapshot, setSnapshot] = useState<{ client: KernelClient; info: DocumentInfoResult }>();
  const [pending, setPending] = useState<{ client: KernelClient; busy: boolean }>();
  const currentInfo = useRef<DocumentInfoResult | undefined>(undefined);

  useEffect(() => {
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
      const active = capture(token);
      return work(target, active)
        .catch((error: unknown) => {
          if (active() && !isFileDialogCancelled(error))
            latest.current.options.reportError(action, error);
        })
        .finally(() => {
          if (active()) setPending({ client: target, busy: false });
          if (operation.current === token) operation.current = undefined;
        });
    },
    [capture, latest, operation],
  );

  const importFile = useCallback(
    async (target: KernelClient, active: () => boolean, file: File) => {
      let success = false;
      try {
        if (file.size > 1024 * 1024 * 1024) throw new Error("File exceeds the 1 GiB import limit.");
        const current = currentInfo.current;
        if (current && desktopBridge()) {
          const history = await target.call("history.list", { documentId: current.documentId });
          if (!active()) return;
          if (history.dirty && !(await desktopBridge()?.confirmReplace(current.name))) return;
        }
        const stopping = latest.current.options.beforeOpen();
        const [stopped, reading] = await Promise.allSettled([
          stopping,
          Promise.resolve().then(() => file.arrayBuffer()),
        ]);
        if (!active()) return;
        if (stopped.status === "rejected") throw stopped.reason;
        if (reading.status === "rejected") throw reading.reason;
        const info = await openAudioDocument(target, file.name, reading.value, active);
        if (info && active()) {
          currentInfo.current = info;
          setSnapshot({ client: target, info });
          success = true;
        }
      } finally {
        await finishNativeOpen(file, success);
      }
    },
    [latest],
  );

  const openFile = useCallback(
    (file: File) => {
      void run("Could not open audio", (target, active) => importFile(target, active, file));
    },
    [importFile, run],
  );

  const openNativeFile = useCallback(
    (selected: NativeFile) =>
      run("Could not open audio", async (target, active) => {
        const file = await readNativeFile(selected);
        if (active()) await importFile(target, active, file);
        else await finishNativeOpen(file, false);
      }),
    [importFile, run],
  );

  const open = useCallback(() => {
    void run("Could not open audio", async (target, active) => {
      const file = await chooseAudioFile(() => {
        if (active()) latest.current.options.fallbackOpen();
      });
      if (file && active()) await importFile(target, active, file);
      else if (file) await finishNativeOpen(file, false);
    });
  }, [importFile, run, latest]);

  const openDemo = useCallback(() => {
    void run("Could not open demo", async (target, active) => {
      const response = await fetch(`${import.meta.env.BASE_URL}demo.wav`);
      if (!response.ok) throw new Error(`Demo download failed (${response.status}).`);
      const blob = await response.blob();
      if (active())
        await importFile(target, active, new File([blob], "demo.wav", { type: "audio/wav" }));
    });
  }, [importFile, run]);

  const info = snapshot?.client === client ? snapshot?.info : undefined;
  currentInfo.current = info;
  /** Edits share the file-operation lock, including preparation and confirmation. */
  const withOperation = useCallback(
    async (work: () => Promise<void>) => {
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
    },
    [latest, mounted, operation],
  );
  const refreshInfo = useCallback(
    async (target: KernelClient) => {
      if (!mounted.current || latest.current.client !== target) return;
      const started = ++generation.current;
      const info = await target.call("doc.info");
      if (!mounted.current || latest.current.client !== target || generation.current !== started)
        return;
      currentInfo.current = info;
      setSnapshot({ client: target, info });
    },
    [mounted, latest],
  );
  const replaceInfo = useCallback(
    (next: DocumentInfoResult, expectedDocumentId: string) => {
      const target = latest.current.client;
      if (!mounted.current || !target) return false;
      if (currentInfo.current?.documentId !== expectedDocumentId) {
        void refreshInfo(target).catch((error: unknown) =>
          latest.current.options.reportError("Could not refresh audio document", error),
        );
        return false;
      }
      generation.current++;
      currentInfo.current = next;
      setSnapshot({ client: target, info: next });
      return true;
    },
    [refreshInfo, latest, mounted],
  );
  const saveAndWait = useCallback(() => {
    if (!info || latest.current.client !== client) return;
    let savedSuccessfully = false;
    const work = run("Could not save audio", async (target, active) => {
      const settings = defaultExportSettings(info);
      const params = exportParams(
        info,
        { start: 0, end: info.frames, channelMask: 2 ** info.channels - 1 },
        settings,
      );
      if (!params) throw new Error("Unsupported save format");
      const destination = await chooseSaveTarget(
        exportName(info.name, params.format),
        exportFileTypes(params.format),
      );
      if (!destination) return;
      try {
        if (!active()) return;
        const history = await target.call("history.list", { documentId: info.documentId });
        if (!active()) return;
        const result = await target.call("doc.export", params);
        if (!active()) return;
        await destination.write(result);
        if (!active()) return;
        // Exporting does not save: only acknowledge the exact state after a
        // successful destination write, still under the shared operation lock.
        const saved = await target.call("doc.mark-saved", {
          documentId: info.documentId,
          stateId: history.currentStateId,
        });
        if (active()) {
          latest.current.options.onSaved?.(saved);
          savedSuccessfully = !saved.dirty;
        }
      } finally {
        await destination.dispose?.();
      }
    });
    return work?.then(() => savedSuccessfully);
  }, [client, info, run, latest]);

  const save = useCallback(() => {
    void saveAndWait();
  }, [saveAndWait]);

  const exportTimeline = useCallback(
    (format: TimelineExportParams["format"]) => {
      if (!info || latest.current.client !== client) return;
      run("Could not export markers and regions", async (target, active) => {
        const base = info.name.replace(/\.[^.]+$/, "") || "Untitled";
        const csv = format === "csv";
        const destination = await chooseSaveTarget(
          `${base}.${csv ? "markers.csv" : "labels.txt"}`,
          [
            {
              description: csv ? "Marker CSV" : "Label file",
              accept: { [csv ? "text/csv" : "text/plain"]: [csv ? ".csv" : ".txt"] },
            },
          ],
        );
        if (!destination) return;
        try {
          if (!active()) return;
          const result = await target.call("timeline.export", {
            documentId: info.documentId,
            format,
          });
          if (active()) await destination.write(result);
        } finally {
          await destination.dispose?.();
        }
        // A sidecar export never acknowledges the document's save point.
      });
    },
    [client, info, run, latest],
  );

  return {
    info,
    busy: pending?.client === client && pending?.busy === true,
    open,
    openFile,
    openDemo,
    openNativeFile,
    save,
    saveAndWait,
    exportTimeline,
    withOperation,
    replaceInfo,
    refreshInfo,
  };
}
