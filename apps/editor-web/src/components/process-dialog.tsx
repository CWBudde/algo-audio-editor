import { useId, useLayoutEffect, useRef } from "react";
import { type ProcessView, parseGain } from "@/hooks/use-process";

interface ProcessDialogProps {
  view?: ProcessView;
  onGainTextChange(value: string): void;
  onPreview(): void;
  onStopPreview(): void;
  onApply(allowClipping: boolean): void;
  onCancel(): void;
}

export function ProcessDialog({
  view,
  onGainTextChange,
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
  const gainDb = view ? parseGain(view.gainText) : undefined;
  const working =
    view?.phase === "processing" || view?.phase === "committing" || view?.phase === "cancelling";
  const ready = view?.job?.state === "ready" && view.job.gainDb === gainDb;
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
        Amplify
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
          <label className="mt-3 block text-sm" htmlFor={`${id}-gain`}>
            Gain (dB)
          </label>
          <input
            ref={gain}
            id={`${id}-gain`}
            type="text"
            inputMode="decimal"
            value={view.gainText}
            disabled={working}
            aria-invalid={gainDb === undefined}
            aria-describedby={gainDb === undefined ? `${id}-error` : undefined}
            className="mt-1 w-full rounded border bg-background px-3 py-2"
            onChange={(event) => onGainTextChange(event.target.value)}
          />
          {gainDb === undefined && (
            <p id={`${id}-error`} role="alert" className="mt-1 text-sm text-destructive">
              Enter a finite gain between −120 and 60 dB.
            </p>
          )}
          <div className="mt-4" aria-live="polite">
            <p role="status" className="text-sm" data-testid="process-status">
              {view.phase === "cancelling"
                ? "Cancelling…"
                : view.phase === "committing"
                  ? "Applying…"
                  : view.phase === "processing"
                    ? "Processing…"
                    : view.previewing
                      ? `Previewing ${view.job?.gainDb ?? gainDb} dB`
                      : ready
                        ? "Processed copy ready"
                        : "Ready to process"}
            </p>
            {view.job && (
              <progress
                aria-label="Processing progress"
                className="mt-2 w-full"
                max={view.job.totalFrames}
                value={view.job.processedFrames}
              />
            )}
            {ready && view.job && (
              <p className="mt-1 text-xs text-muted-foreground">
                Predicted peak: {view.job.peak.toFixed(6)}
                {view.job.nonFinite ? " · nonfinite samples present" : ""}
              </p>
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
              disabled={working || gainDb === undefined}
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
              disabled={working || gainDb === undefined}
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
