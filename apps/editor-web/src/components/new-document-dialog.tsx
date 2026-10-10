import type { DocumentNewParams } from "@aae/protocol";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { useRestoringModal } from "@/hooks/use-restoring-modal";

const SAMPLE_RATES = [
  8000, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000, 176400, 192000, 384000,
] as const;
const CHANNELS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
const MAX_SECONDS = 86_400;

/** Collects the format of a new silent document; the kernel creates it. */
export function NewDocumentDialog({
  open,
  onCreate,
  onClose,
}: {
  open: boolean;
  onCreate(params: Omit<DocumentNewParams, "name">): void;
  onClose(): void;
}) {
  const id = useId();
  const rateField = useRef<HTMLSelectElement>(null);
  const dialog = useRestoringModal(open, rateField);
  const [sampleRate, setSampleRate] = useState(48000);
  const [channels, setChannels] = useState(2);
  const [lengthText, setLengthText] = useState("0");
  useLayoutEffect(() => {
    if (!open) return;
    setSampleRate(48000);
    setChannels(2);
    setLengthText("0");
  }, [open]);
  const seconds = lengthText.trim() ? Number(lengthText) : Number.NaN;
  const valid = Number.isFinite(seconds) && seconds >= 0 && seconds <= MAX_SECONDS;
  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${id}-title`}
      aria-modal="true"
      data-testid="new-document-dialog"
      className="studio-dialog m-auto max-h-[calc(100dvh-2rem)] w-[min(26rem,calc(100vw-2rem))] overflow-y-auto border p-5 text-popover-foreground backdrop:bg-background/75 backdrop:backdrop-blur-[2px]"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={() => {
        if (!dialog.current?.open) onClose();
      }}
    >
      <h2 id={`${id}-title`} className="studio-dialog-heading text-lg font-semibold tracking-tight">
        New document
      </h2>
      {open && (
        <form
          className="mt-3 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) onCreate({ sampleRate, channels, frames: Math.round(seconds * sampleRate) });
          }}
        >
          <label className="block text-xs font-medium text-muted-foreground">
            Sample rate
            <select
              ref={rateField}
              value={sampleRate}
              className="studio-field mt-1 w-full border px-3 py-2 text-sm text-foreground"
              onChange={(event) => setSampleRate(Number(event.target.value))}
            >
              {SAMPLE_RATES.map((rate) => (
                <option key={rate} value={rate}>
                  {rate.toLocaleString("en-US")} Hz
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-medium text-muted-foreground">
            Channels
            <select
              value={channels}
              className="studio-field mt-1 w-full border px-3 py-2 text-sm text-foreground"
              onChange={(event) => setChannels(Number(event.target.value))}
            >
              {CHANNELS.map((count) => (
                <option key={count} value={count}>
                  {count === 1 ? "1 (mono)" : count === 2 ? "2 (stereo)" : String(count)}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-medium text-muted-foreground">
            Length (seconds)
            <input
              type="text"
              inputMode="decimal"
              value={lengthText}
              aria-invalid={!valid}
              aria-describedby={valid ? `${id}-help` : `${id}-error`}
              className="studio-field mt-1 w-full border px-3 py-2 text-sm text-foreground"
              onChange={(event) => setLengthText(event.target.value)}
            />
          </label>
          {valid ? (
            <p id={`${id}-help`} className="text-xs text-muted-foreground">
              The document starts as silence of this length; 0 creates an empty document.
            </p>
          ) : (
            <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
              Enter a length between 0 and 86,400 seconds.
            </p>
          )}
          <div className="studio-dialog-actions flex justify-end gap-2 border-t pt-3">
            <button
              type="button"
              className="studio-button border px-3 py-2 text-sm"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="studio-button studio-button-primary border px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
              disabled={!valid}
            >
              Create
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
