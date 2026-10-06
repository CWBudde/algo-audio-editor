import { useId, useLayoutEffect, useRef } from "react";
import {
  matchesProcessSettings,
  type ProcessOperation,
  type ProcessView,
  parseProcessParameter,
} from "@/hooks/use-process";
import {
  defaultProcessSettings,
  PROCESS_TITLES,
  type ProcessSettings,
  processParams,
} from "@/lib/process-settings";
import { ProcessControls } from "./process-controls";

interface ProcessDialogProps {
  view?: ProcessView;
  onParameterTextChange(value: string): void;
  onOperationChange(value: ProcessOperation): void;
  onSettingsChange?(value: Partial<ProcessSettings>): void;
  onPreview(): void;
  onStopPreview(): void;
  onApply(allowClipping: boolean): void;
  onCancel(): void;
}

export function ProcessDialog({
  view,
  onParameterTextChange,
  onOperationChange,
  onSettingsChange,
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
  const returnFocus = view?.returnFocus;
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
    opener.current = returnFocus?.isConnected
      ? returnFocus
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    element.showModal();
    (gain.current ?? element.querySelector<HTMLElement>("input, select, button"))?.focus();
    return () => {
      element.close();
      if (!latestOpen.current) return;
      const target = opener.current;
      // Conditional unmount cleanup runs before React enables the launcher.
      queueMicrotask(() => {
        if (!element.open && target?.isConnected) target.focus({ preventScroll: true });
      });
      opener.current = undefined;
    };
  }, [open, returnFocus]);
  const value = view ? parseProcessParameter(view.operation, view.parameterText) : undefined;
  const normalize =
    view?.operation === "normalize-peak" || view?.operation === "normalize-loudness";
  const numeric =
    view?.operation === "gain" || view?.operation === "spectral-attenuate" || normalize;
  const valid = Boolean(
    view &&
      processParams(
        view.info,
        view.selection,
        view.operation,
        view.parameterText,
        view.settings ?? defaultProcessSettings(view.info),
      ),
  );
  const working =
    view?.phase === "processing" || view?.phase === "committing" || view?.phase === "cancelling";
  const ready = view
    ? (view.ready ?? matchesProcessSettings(view.job, view.operation, value))
    : false;
  const warning = Boolean(ready && view?.job && (view.job.peak > 1 || view.job.nonFinite));
  const cancellable = view?.phase !== "committing" && view?.phase !== "cancelling";
  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-help`}
      aria-modal="true"
      className="studio-dialog m-auto max-h-[calc(100dvh-2rem)] w-[min(32rem,calc(100vw-2rem))] overflow-y-auto border p-5 text-popover-foreground backdrop:bg-background/75 backdrop:backdrop-blur-[2px]"
      onCancel={(event) => {
        event.preventDefault();
        if (cancellable) onCancel();
      }}
    >
      <h2 id={`${id}-title`} className="studio-dialog-heading text-lg font-semibold tracking-tight">
        {view ? PROCESS_TITLES[view.operation] : "Amplify"}
      </h2>
      <p
        id={`${id}-help`}
        className="studio-dialog-help mt-1 max-w-[72ch] text-sm leading-relaxed text-muted-foreground"
      >
        {view?.operation === "extract-channel"
          ? "Preview a private copy, then open it in a new editor window."
          : "Preview a private processed copy. Apply creates one undoable edit; Cancel discards it."}
      </p>
      {view && (
        <>
          <p className="studio-section mt-3 border px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            {view.info.name} · frames {view.selection.start}–{view.selection.end} · channel mask{" "}
            {view.selection.channelMask}
          </p>
          {normalize && (
            <>
              <p className="mt-1 text-xs text-muted-foreground">
                One linked gain across the selected channels; other channels stay unchanged.
              </p>
              <label
                className="mt-3 block text-xs font-medium text-muted-foreground"
                htmlFor={`${id}-mode`}
              >
                Normalization mode
              </label>
              <select
                id={`${id}-mode`}
                value={view.operation}
                disabled={working}
                className="studio-field mt-1 w-full border px-3 py-2 text-sm"
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
          {numeric && (
            <>
              <label
                className="mt-3 block text-xs font-medium text-muted-foreground"
                htmlFor={`${id}-gain`}
              >
                {view.operation === "gain" || view.operation === "spectral-attenuate"
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
                className="studio-field mt-1 w-full border px-3 py-2 text-sm"
                onChange={(event) => onParameterTextChange(event.target.value)}
              />
              {value === undefined && (
                <p id={`${id}-error`} role="alert" className="mt-1 text-sm text-destructive">
                  {view.operation === "spectral-attenuate"
                    ? "Enter a finite attenuation between −120 and 0 dB."
                    : view.operation === "gain"
                      ? "Enter a finite gain between −120 and 60 dB."
                      : view.operation === "normalize-peak"
                        ? "Enter a finite target between −120 and 0 dBFS."
                        : "Enter a finite target between −69 and 0 LUFS."}
                </p>
              )}
            </>
          )}
          {view.operation === "spectral-attenuate" && value !== undefined && !valid && (
            <p role="alert" className="mt-2 text-sm text-destructive">
              Choose finite frequency bounds from 0 Hz to half the sample rate, with the upper bound
              above the lower bound.
            </p>
          )}
          {(!numeric || view.operation === "spectral-attenuate") && (
            <ProcessControls
              view={view}
              disabled={working}
              onOperationChange={onOperationChange}
              onSettingsChange={onSettingsChange ?? (() => {})}
            />
          )}
          {!numeric && !valid && (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {view.operation === "crossfade"
                ? "Choose a cursor with enough audio on both sides and an overlap of at least two frames."
                : view.operation === "spectral-heal"
                  ? "Select at most 256 samples with intact audio on both sides."
                  : view.operation === "noise-reduce"
                    ? "Choose a valid profile for these channels and reduction from 0 to 60 dB."
                    : view.operation === "time-stretch"
                      ? "Choose all channels and a duration multiplier from 0.25 to 4."
                      : view.operation === "remove-clicks" ||
                          view.operation === "declip" ||
                          view.operation === "remove-hum"
                        ? "Enter valid restoration settings within the supported ranges."
                        : "Enter valid settings. Frequencies must be positive and at most half the sample rate; sample rates must be whole hertz from 8000 to 384000."}
            </p>
          )}
          <div className="studio-section mt-4 border p-3" aria-live="polite">
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
                {numeric && view.job.gainResolved && view.job.unchangedReason !== "silent" && (
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
              <p role="alert" className="mt-2 text-sm text-warning">
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
          <div className="studio-dialog-actions mt-4 flex flex-wrap justify-end gap-2 border-t border-border pt-3">
            <button
              type="button"
              className="studio-button border px-3 py-2 text-sm disabled:opacity-50"
              disabled={working || !valid}
              onClick={onPreview}
            >
              Preview
            </button>
            <button
              type="button"
              className="studio-button border px-3 py-2 text-sm disabled:opacity-50"
              disabled={working || !view.previewing}
              onClick={onStopPreview}
            >
              Stop preview
            </button>
            <button
              type="button"
              className="studio-button border px-3 py-2 text-sm disabled:opacity-50"
              disabled={!cancellable}
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className="studio-button studio-button-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
              disabled={working || !valid}
              onClick={() => onApply(warning)}
            >
              {warning
                ? "Apply anyway"
                : view.operation === "extract-channel"
                  ? "Open extracted channel"
                  : "Apply"}
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}
