import type { DocumentInfoResult, SelectionRange } from "@aae/protocol";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { KernelClient } from "@/kernel/client";
import {
  defaultExportSettings,
  type ExportSettings,
  exportParams,
  updateExportSettings,
} from "@/lib/export-settings";
import { chooseSaveTarget, isFileDialogCancelled } from "@/lib/file-access";

export interface ExportOptions {
  client?: KernelClient;
  info?: DocumentInfoResult;
  busy?: boolean;
  withOperation(work: () => Promise<void>): Promise<void>;
  onError(action: string, error: unknown): void;
}
export interface ExportView {
  info: DocumentInfoResult;
  selection: SelectionRange;
  settings: ExportSettings;
  phase: "idle" | "exporting" | "cancelling";
  error?: string;
}
interface Session extends ExportView {
  client: KernelClient;
  pending?: Promise<void>;
  closing: boolean;
}

/** Export fences the document through its chooser, kernel export and destination write. */
export function useExport(options: ExportOptions) {
  const latest = useRef(options);
  latest.current = options;
  const mounted = useRef(false);
  const session = useRef<Session | undefined>(undefined);
  const [view, setView] = useState<ExportView>();
  const owns = useCallback(
    (s: Session) =>
      mounted.current &&
      session.current === s &&
      latest.current.client === s.client &&
      latest.current.info?.documentId === s.info.documentId,
    [],
  );
  const update = useCallback(
    (s: Session, change: Partial<ExportView>) => {
      if (owns(s)) setView((previous) => (previous ? { ...previous, ...change } : previous));
    },
    [owns],
  );
  const report = useCallback(
    (s: Session, error: unknown) => {
      if (owns(s) && !isFileDialogCancelled(error)) {
        update(s, { error: error instanceof Error ? error.message : String(error) });
        latest.current.onError("Could not export audio", error);
      }
    },
    [owns, update],
  );
  const finish = useCallback((s: Session) => {
    if (session.current === s) {
      session.current = undefined;
      if (mounted.current) setView(undefined);
    }
  }, []);
  const cancel = useCallback(async () => {
    const s = session.current;
    if (!s || s.closing) return;
    s.closing = true;
    update(s, { phase: "cancelling" });
    await s.pending?.catch(() => {});
    finish(s);
  }, [update, finish]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a replaced client or document invalidates the entire modal session.
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const s = session.current;
      if (s) {
        s.closing = true;
        session.current = undefined;
      }
      setView(undefined);
    };
  }, [options.client, options.info?.documentId]);

  const open = useCallback((selection: SelectionRange) => {
    const initial = latest.current;
    const { client, info } = initial;
    if (!mounted.current || !client || !info || initial.busy || session.current) return;
    const s: Session = {
      client,
      info,
      selection: { ...selection },
      settings: defaultExportSettings(info),
      phase: "idle",
      closing: false,
    };
    session.current = s;
    setView({ info, selection: s.selection, settings: s.settings, phase: "idle" });
  }, []);
  const setSettings = useCallback(
    (change: Partial<ExportSettings>) => {
      const s = session.current;
      if (!s || s.closing || s.pending) return;
      s.settings = updateExportSettings(s.settings, change);
      update(s, { settings: s.settings });
    },
    [update],
  );
  const submit = useCallback(() => {
    const s = session.current;
    if (!s || s.closing || s.pending || !owns(s)) return;
    const params = exportParams(s.info, s.selection, s.settings);
    if (!params) return;
    const name =
      params.scope === "selection"
        ? `${s.info.name.replace(/\.[^./]*$/, "") || "Untitled"}-selection.wav`
        : s.info.name;
    update(s, { phase: "exporting", error: undefined });
    s.pending = (async () => {
      let written = false;
      try {
        await latest.current.withOperation(async () => {
          // The document fence is acquired synchronously, so the chooser runs
          // under the Export button gesture before the first workflow await.
          const destination = await chooseSaveTarget(name);
          if (!destination || s.closing || !owns(s)) return;
          if (params.scope === "selection") {
            const current = await s.client.call("selection.get", { documentId: s.info.documentId });
            if (s.closing || !owns(s)) return;
            if (
              current.start !== s.selection.start ||
              current.end !== s.selection.end ||
              current.channelMask !== s.selection.channelMask
            )
              throw new Error("The selection changed. Close Export and choose the range again.");
          }
          const result = await s.client.call("doc.export", params);
          if (s.closing || !owns(s)) return;
          await destination.write(result);
          written = true;
        });
        if (!s.closing && owns(s)) {
          if (written) finish(s);
          else update(s, { phase: "idle" });
        }
      } catch (error) {
        report(s, error);
        if (!s.closing && owns(s)) update(s, { phase: "idle" });
      } finally {
        s.pending = undefined;
        if (s.closing || !owns(s)) finish(s);
      }
    })();
    return s.pending;
  }, [owns, update, report, finish]);
  return { view, open, setSettings, submit, cancel };
}
