import { useId, useLayoutEffect, useRef } from "react";
import type { ExportView } from "@/hooks/use-export";
import {
  type ExportSettings,
  exportParams,
  FLOAT_DEPTHS,
  PCM_DEPTHS,
  validExportSelection,
} from "@/lib/export-settings";

interface Props {
  view?: ExportView;
  onSettingsChange(value: Partial<ExportSettings>): void;
  onExport(): void;
  onCancel(): void;
}
const fieldClass = "mt-1 w-full rounded border bg-background px-3 py-2";

export function ExportDialog({ view, onSettingsChange, onExport, onCancel }: Props) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | undefined>(undefined);
  const open = Boolean(view);
  const latestOpen = useRef(open);
  latestOpen.current = open;
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!open) {
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
      opener.current = undefined;
      return;
    }
    opener.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    element.showModal();
    element.querySelector<HTMLElement>("select")?.focus();
    return () => {
      element.close();
      if (!latestOpen.current) return;
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
      opener.current = undefined;
    };
  }, [open]);
  const working = view?.phase !== "idle";
  const settings = view?.settings;
  const valid = Boolean(view && exportParams(view.info, view.selection, view.settings));
  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-help`}
      aria-modal="true"
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border bg-popover p-5 text-popover-foreground shadow-xl backdrop:bg-black/50"
      onCancel={(event) => {
        event.preventDefault();
        if (!working) onCancel();
      }}
    >
      <h2 id={`${id}-title`} className="text-lg font-medium">
        Export audio
      </h2>
      <p id={`${id}-help`} className="mt-1 text-sm text-muted-foreground">
        Choose the range and WAV encoding for the exported copy.
      </p>
      {view && settings && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!working && valid) onExport();
          }}
        >
          <p className="mt-3 text-sm">
            {view.info.name} · {view.info.sampleRate} Hz · {view.info.channels} channels
          </p>
          <label className="mt-3 block text-sm" htmlFor={`${id}-scope`}>
            Range
          </label>
          <select
            id={`${id}-scope`}
            className={fieldClass}
            value={settings.scope}
            disabled={working}
            onChange={(event) =>
              onSettingsChange({
                scope: event.target.value === "selection" ? "selection" : "document",
              })
            }
          >
            <option value="document">Whole document</option>
            <option value="selection" disabled={!validExportSelection(view.selection, view.info)}>
              Selection (selected channels)
            </option>
          </select>
          {settings.scope === "selection" && (
            <p className="mt-1 text-xs text-muted-foreground">
              Frames {view.selection.start}–{view.selection.end} · channels{" "}
              {Array.from({ length: view.info.channels }, (_, channel) => channel)
                .filter((channel) => view.selection.channelMask & (1 << channel))
                .map((channel) => channel + 1)
                .join(", ")}
            </p>
          )}
          <label className="mt-3 block text-sm" htmlFor={`${id}-format`}>
            Format
          </label>
          <select
            id={`${id}-format`}
            className={fieldClass}
            value={settings.encoding}
            disabled={working}
            onChange={(event) =>
              onSettingsChange({ encoding: event.target.value === "float" ? "float" : "pcm" })
            }
          >
            <option value="pcm">WAV PCM</option>
            <option value="float">WAV float</option>
          </select>
          <label className="mt-3 block text-sm" htmlFor={`${id}-depth`}>
            Bit depth
          </label>
          <select
            id={`${id}-depth`}
            className={fieldClass}
            value={settings.bitDepth}
            disabled={working}
            onChange={(event) => onSettingsChange({ bitDepth: Number(event.target.value) })}
          >
            {(settings.encoding === "float" ? FLOAT_DEPTHS : PCM_DEPTHS).map((depth) => (
              <option key={depth} value={depth}>
                {depth}-bit
              </option>
            ))}
          </select>
          {settings.encoding === "pcm" && (
            <>
              <label className="mt-3 block text-sm" htmlFor={`${id}-dither`}>
                Dither
              </label>
              <select
                id={`${id}-dither`}
                className={fieldClass}
                value={settings.dither}
                disabled={working}
                onChange={(event) =>
                  onSettingsChange({ dither: event.target.value as ExportSettings["dither"] })
                }
              >
                <option value="none">None</option>
                <option value="rectangular">Rectangular</option>
                <option value="triangular">Triangular</option>
                <option value="gaussian">Gaussian</option>
                <option value="fast-gaussian">Fast Gaussian</option>
              </select>
              <label className="mt-3 block text-sm" htmlFor={`${id}-shaping`}>
                Noise shaping
              </label>
              <select
                id={`${id}-shaping`}
                className={fieldClass}
                value={settings.noiseShaping}
                disabled={working}
                onChange={(event) =>
                  onSettingsChange({
                    noiseShaping: event.target.value as ExportSettings["noiseShaping"],
                  })
                }
              >
                <option value="none">None</option>
                <option value="efb">Error feedback (EFB)</option>
                <option value="2sc">2SC</option>
                <option value="9fc">9FC</option>
                <option value="sbm">Sony SBM</option>
                <option value="sharp">Sharp</option>
              </select>
            </>
          )}
          {view.error && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {view.error}
            </p>
          )}
          <p role="status" aria-live="polite" className="mt-4 text-sm">
            {view.phase === "exporting"
              ? "Exporting…"
              : view.phase === "cancelling"
                ? "Cancelling…"
                : "Ready to export"}
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              className="rounded border px-3 py-2 text-sm disabled:opacity-50"
              disabled={working}
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
              disabled={working || !valid}
            >
              Export
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
