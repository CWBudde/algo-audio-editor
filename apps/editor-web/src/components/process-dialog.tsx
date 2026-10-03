import { useId, useLayoutEffect, useRef } from "react";
import {
  matchesProcessSettings,
  type ProcessView,
  parseProcessParameter,
} from "@/hooks/use-process";

interface ProcessDialogProps {
  view?: ProcessView;
  onParameterTextChange(value: string): void;
  onOperationChange(value: "normalize-peak" | "normalize-loudness"): void;
  onPreview(): void;
  onStopPreview(): void;
  onApply(allowClipping: boolean): void;
  onCancel(): void;
}

export function ProcessDialog({
  view,
  onParameterTextChange,
  onOperationChange,
  onPreview,
  onStopPreview,
  onApply,
  onCancel,
}: ProcessDialogProps) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const gain = useRef<HTMLInputElement>(null);
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
    gain.current?.focus();
    return () => {
      element.close();
      if (!latestOpen.current) return;
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
      opener.current = undefined;
    };
  }, [open]);
  const value = view ? parseProcessParameter(view.operation, view.parameterText) : undefined;
  const normalize = Boolean(view && view.operation !== "gain");
  const working =
    view?.phase === "processing" || view?.phase === "committing" || view?.phase === "cancelling";
  const ready = view ? matchesProcessSettings(view.job, view.operation, value) : false;
  const warning = Boolean(ready && view?.job && (view.job.peak > 1 || view.job.nonFinite));
  const cancellable = view?.phase !== "committing" && view?.phase !== "cancelling";
  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-help`}
      aria-modal="true"
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border bg-popover p-5 text-popover-foreground shadow-xl backdrop:bg-black/50"
      onCancel={(event) => {
        event.preventDefault();
        if (cancellable) onCancel();
      }}
    >
      <h2 id={`${id}-title`} className="text-lg font-medium">
        {normalize ? "Normalize" : "Amplify"}
      </h2>
      <p id={`${id}-help`} className="mt-1 text-sm text-muted-foreground">
        Preview a private processed copy. Apply creates one undoable edit; Cancel discards it.
      </p>
      {view && (
        <>
          <p className="mt-3 text-sm">
            {view.info.name} · frames {view.selection.start}–{view.selection.end} · channel mask{" "}
            {view.selection.channelMask}
          </p>
          {normalize && (
            <>
              <p className="mt-1 text-xs text-muted-foreground">
                One linked gain across the selected channels; other channels stay unchanged.
              </p>
              <label className="mt-3 block text-sm" htmlFor={`${id}-mode`}>
                Normalization mode
              </label>
              <select
                id={`${id}-mode`}
                value={view.operation}
                disabled={working}
                className="mt-1 w-full rounded border bg-background px-3 py-2"
                onChange={(event) =>
                  onOperationChange(
                    event.target.value === "normalize-loudness"
                      ? "normalize-loudness"
                      : "normalize-peak",
                  )
                }
              >
                <option value="normalize-peak">Peak (dBFS)</option>
                <option value="normalize-loudness">Integrated loudness (LUFS)</option>
              </select>
            </>
          )}
          <label className="mt-3 block text-sm" htmlFor={`${id}-gain`}>
            {view.operation === "gain"
              ? "Gain (dB)"
              : view.operation === "normalize-peak"
                ? "Target peak (dBFS)"
                : "Target loudness (LUFS)"}
          </label>
          <input
            ref={gain}
            id={`${id}-gain`}
            type="text"
            inputMode="decimal"
            value={view.parameterText}
            disabled={working}
            aria-invalid={value === undefined}
            aria-describedby={value === undefined ? `${id}-error` : undefined}
            className="mt-1 w-full rounded border bg-background px-3 py-2"
            onChange={(event) => onParameterTextChange(event.target.value)}
          />
          {value === undefined && (
            <p id={`${id}-error`} role="alert" className="mt-1 text-sm text-destructive">
              {view.operation === "gain"
                ? "Enter a finite gain between −120 and 60 dB."
                : view.operation === "normalize-peak"
                  ? "Enter a finite target between −120 and 0 dBFS."
                  : "Enter a finite target between −69 and 0 LUFS."}
            </p>
          )}
          <div className="mt-4" aria-live="polite">
            <p role="status" className="text-sm" data-testid="process-status">
              {view.phase === "cancelling"
                ? "Cancelling…"
                : view.phase === "committing"
                  ? "Applying…"
                  : view.phase === "processing"
                    ? view.job?.phase === "analyzing"
                      ? "Analyzing…"
                      : view.job?.phase === "verifying"
                        ? "Verifying loudness…"
                        : "Processing…"
                    : view.previewing
                      ? "Previewing processed copy"
                      : ready
                        ? view.job?.unchangedReason === "silent"
                          ? "No change: selected audio is silent"
                          : "Processed copy ready"
                        : "Ready to process"}
            </p>
            {view.job && (
              <>
                <p className="mt-1 text-xs text-muted-foreground">
                  Phase {view.job.phaseIndex + 1} of {view.job.phaseCount}
                </p>
                <progress
                  aria-label="Processing progress"
                  className="mt-2 w-full"
                  max={view.job.totalFrames}
                  value={view.job.processedFrames}
                />
              </>
            )}
            {ready && view.job && (
              <div className="mt-1 text-xs text-muted-foreground">
                <p>
                  Output sample peak: {view.job.peak.toFixed(6)}
                  {view.job.nonFinite ? " · nonfinite samples present" : ""}
                </p>
                {view.job.gainResolved && view.job.unchangedReason !== "silent" && (
                  <p>Resolved gain: {view.job.gainDb.toFixed(3)} dB</p>
                )}
                {normalize && <p>Input sample peak: {view.job.inputPeak.toFixed(6)}</p>}
                {view.operation === "normalize-loudness" && (
                  <>
                    <p>
                      {view.job.inputLufs === null
                        ? view.job.unchangedReason === "silent"
                          ? "Source loudness unavailable: silence"
                          : "Source loudness unavailable: below the absolute gate"
                        : `Source integrated loudness: ${view.job.inputLufs.toFixed(2)} LUFS`}
                    </p>
                    {view.job.predictedLufs !== null && (
                      <p>Predicted output loudness: {view.job.predictedLufs.toFixed(2)} LUFS</p>
                    )}
                    {view.job.outputLufs !== null && (
                      <p>Measured output loudness: {view.job.outputLufs.toFixed(2)} LUFS</p>
                    )}
                  </>
                )}
              </div>
            )}
            {warning && (
              <p role="alert" className="mt-2 text-sm text-amber-400">
                The processed result exceeds full scale or contains nonfinite samples. PCM export
                may clip. Apply anyway to keep this result.
              </p>
            )}
            {view.previewing && !ready && (
              <p className="mt-1 text-xs text-muted-foreground">
                Settings changed. Preview or Apply rebuilds the copy.
              </p>
            )}
          </div>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              className="rounded border px-3 py-2 text-sm disabled:opacity-50"
              disabled={working || value === undefined}
              onClick={onPreview}
            >
              Preview
            </button>
            <button
              type="button"
              className="rounded border px-3 py-2 text-sm disabled:opacity-50"
              disabled={working || !view.previewing}
              onClick={onStopPreview}
            >
              Stop preview
            </button>
            <button
              type="button"
              className="rounded border px-3 py-2 text-sm disabled:opacity-50"
              disabled={!cancellable}
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
              disabled={working || value === undefined}
              onClick={() => onApply(warning)}
            >
              {warning ? "Apply anyway" : "Apply"}
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}
