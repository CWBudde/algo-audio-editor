import type { DocumentInfoResult, ExportResult, SelectionRange } from "@aae/protocol";
import { useCallback, useState } from "react";
import { useKernelSession } from "@/hooks/use-kernel-session";
import type { KernelClient } from "@/kernel/client";
import {
  defaultExportSettings,
  type ExportSettings,
  exportFileTypes,
  exportName,
  exportParams,
  isLossyFormat,
  updateExportSettings,
  validExportSelection,
} from "@/lib/export-settings";
import { chooseSaveTarget, isFileDialogCancelled } from "@/lib/file-access";
import {
  type EncoderSupport,
  encoderSupport,
  exportGeometry,
  exportLossy,
  LOSSY_BITRATES,
} from "@/lib/lossy-export";

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
  support?: EncoderSupport;
  canCancel?: boolean;
}
interface Session extends ExportView {
  client: KernelClient;
  pending?: Promise<void>;
  closing: boolean;
  probe: number;
  abort?: AbortController;
}

/** Export fences the document through its chooser, kernel export and destination write. */
export function useExport(options: ExportOptions) {
  const {
    latest,
    mounted,
    token: session,
    active: sessionActive,
  } = useKernelSession<ExportOptions, Session>(
    options,
    options.client,
    options.info?.documentId,
    () => {
      const s = session.current;
      if (s) {
        s.closing = true;
        s.abort?.abort();
        session.current = undefined;
      }
      setView(undefined);
    },
  );
  const [view, setView] = useState<ExportView>();
  const owns = useCallback(
    (s: Session) =>
      sessionActive(s) &&
      latest.current.client === s.client &&
      latest.current.info?.documentId === s.info.documentId,
    [sessionActive, latest],
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
    [owns, update, latest],
  );
  const finish = useCallback(
    (s: Session) => {
      if (session.current === s) {
        session.current = undefined;
        if (mounted.current) setView(undefined);
      }
    },
    [session, mounted],
  );
  const cancel = useCallback(async () => {
    const s = session.current;
    if (!s || s.closing) return;
    s.closing = true;
    s.abort?.abort();
    update(s, { phase: "cancelling" });
    await s.pending?.catch(() => {});
    finish(s);
  }, [update, finish, session]);

  const refreshSupport = useCallback(
    (s: Session) => {
      const probe = ++s.probe;
      const { channels } = exportGeometry(s.info, s.selection, s.settings.scope);
      update(s, { support: undefined });
      void encoderSupport(s.info.sampleRate, channels, s.settings.bitrate ?? 128).then(
        (support) => {
          if (!s.closing && probe === s.probe && owns(s)) {
            s.support = support;
            update(s, { support });
          }
        },
      );
    },
    [owns, update],
  );
  const open = useCallback(
    (selection: SelectionRange) => {
      const initial = latest.current;
      const { client, info } = initial;
      if (!mounted.current || !client || !info || initial.busy || session.current) return;
      const s: Session = {
        client,
        info,
        selection: { ...selection },
        settings: defaultExportSettings(info, { dither: "auto" }),
        phase: "idle",
        closing: false,
        probe: 0,
      };
      session.current = s;
      setView({ info, selection: s.selection, settings: s.settings, phase: "idle" });
      refreshSupport(s);
    },
    [refreshSupport, latest, mounted, session],
  );
  const setSettings = useCallback(
    (change: Partial<ExportSettings>) => {
      const s = session.current;
      if (!s || s.closing || s.pending) return;
      s.settings = updateExportSettings(s.settings, change);
      update(s, { settings: s.settings });
      if (change.scope !== undefined || change.bitrate !== undefined) {
        s.support = undefined;
        refreshSupport(s);
      }
    },
    [update, refreshSupport, session],
  );
  const submit = useCallback(() => {
    const s = session.current;
    if (!s || s.closing || s.pending || !owns(s)) return;
    const params = exportParams(s.info, s.selection, s.settings);
    const format = s.settings.format ?? "wav";
    const lossy = isLossyFormat(format);
    const scope = s.settings.scope;
    const bitrate = s.settings.bitrate ?? 128;
    if (
      lossy
        ? !s.support?.[format] ||
          s.info.frames === 0 ||
          !LOSSY_BITRATES.includes(bitrate as (typeof LOSSY_BITRATES)[number]) ||
          (scope === "selection" && !validExportSelection(s.selection, s.info))
        : !params
    )
      return;
    const name = exportName(s.info.name, format, scope === "selection");
    s.abort = new AbortController();
    update(s, { phase: "exporting", error: undefined, canCancel: lossy });
    s.pending = (async () => {
      let written = false;
      try {
        await latest.current.withOperation(async () => {
          // The document fence is acquired synchronously, so the chooser runs
          // under the Export button gesture before the first workflow await.
          const destination = await chooseSaveTarget(name, exportFileTypes(format));
          if (!destination) return;
          try {
            if (s.closing || !owns(s)) return;
            if (scope === "selection") {
              const current = await s.client.call("selection.get", {
                documentId: s.info.documentId,
              });
              if (s.closing || !owns(s)) return;
              if (
                current.start !== s.selection.start ||
                current.end !== s.selection.end ||
                current.channelMask !== s.selection.channelMask
              )
                throw new Error("The selection changed. Close Export and choose the range again.");
            }
            let result: ExportResult;
            if (isLossyFormat(format)) {
              if (!s.abort) return;
              result = await exportLossy(
                s.client,
                s.info,
                s.selection,
                scope,
                format,
                bitrate,
                s.abort.signal,
              );
            } else {
              if (!params) return;
              result = await s.client.call("doc.export", params);
            }
            if (s.closing || !owns(s)) return;
            update(s, { canCancel: false });
            await destination.write(result);
            written = true;
          } finally {
            await destination.dispose?.();
          }
        });
        if (!s.closing && owns(s)) {
          if (written) finish(s);
          else update(s, { phase: "idle" });
        }
      } catch (error) {
        if (!s.closing) report(s, error);
        if (!s.closing && owns(s)) update(s, { phase: "idle" });
      } finally {
        s.pending = undefined;
        s.abort = undefined;
        if (s.closing || !owns(s)) finish(s);
      }
    })();
    return s.pending;
  }, [owns, update, report, finish, session, latest]);
  return { view, open, setSettings, submit, cancel };
}
