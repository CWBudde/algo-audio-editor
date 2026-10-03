import type {
  ClipboardInfo,
  DocumentInfoResult,
  EditOperation,
  PastePlan,
  SelectionRange,
} from "@aae/protocol";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { parseSelectionTime } from "@/lib/selection";

export interface EditToolbarProps {
  info?: DocumentInfoResult;
  selection?: SelectionRange;
  clipboard?: ClipboardInfo;
  busy?: boolean;
  onRun(operation: EditOperation, selection: SelectionRange, frames?: number): void;
}

export function EditToolbar({ info, selection, clipboard, busy, onRun }: EditToolbarProps) {
  const [silence, setSilence] = useState("48000");
  const errorId = useId();
  useEffect(() => {
    setSilence(String(info?.documentId ? info.sampleRate : 48000));
  }, [info?.documentId, info?.sampleRate]);
  const available = info ? 2 ** info.channels - 1 : 0;
  const valid = Boolean(
    info &&
      selection &&
      Number.isSafeInteger(selection.start) &&
      Number.isSafeInteger(selection.end) &&
      selection.start >= 0 &&
      selection.end >= selection.start &&
      selection.end <= info.frames &&
      Number.isInteger(selection.channelMask) &&
      selection.channelMask > 0 &&
      (selection.channelMask & available) === selection.channelMask,
  );
  const blocked = Boolean(busy || !valid);
  const nonempty = Boolean(selection && selection.end > selection.start);
  const canPaste = Boolean(clipboard?.available && clipboard.frames > 0);
  const silenceFrames = parseSelectionTime(silence, 1, "samples");
  const validSilence = Boolean(
    silenceFrames !== undefined &&
      silenceFrames > 0 &&
      info &&
      Number.isSafeInteger(info.frames + silenceFrames),
  );
  const twoChannels = Boolean(
    selection && [...selection.channelMask.toString(2)].filter((bit) => bit === "1").length === 2,
  );
  const invoke = (operation: EditOperation, frames?: number) => {
    if (!blocked && selection) onRun(operation, selection, frames);
  };
  const button = (label: string, operation: EditOperation, enabled: boolean, title?: string) => (
    <Button
      size="xs"
      variant="outline"
      disabled={blocked || !enabled}
      onClick={() => invoke(operation)}
      title={title}
    >
      {label}
    </Button>
  );
  return (
    <fieldset
      className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5"
      aria-label="Audio edits"
    >
      {button("Cut", "cut", nonempty)}
      {button("Copy", "copy", nonempty)}
      {button("Paste", "paste-insert", canPaste)}
      {button("Replace with clipboard", "paste-replace", canPaste)}
      {button("Mix clipboard", "paste-mix", canPaste)}
      {button("Delete", "delete", nonempty)}
      {button("Crop time (all channels)", "crop", nonempty, "Keep selected time in every channel")}
      {button("Duplicate", "duplicate", nonempty)}
      {button("Swap selected channels", "swap-channels", twoChannels)}
      {button("Mute", "mute", nonempty)}
      <label className="flex items-center gap-1 text-xs">
        Silence frames
        <input
          aria-label="Silence frames"
          aria-invalid={Boolean(info && !validSilence)}
          aria-describedby={info && !validSilence ? errorId : undefined}
          inputMode="numeric"
          className="w-28 rounded border bg-background px-1 py-0.5 tabular-nums"
          value={silence}
          disabled={blocked}
          onChange={(event) => setSilence(event.target.value)}
        />
      </label>
      <Button
        size="xs"
        variant="outline"
        disabled={blocked || !validSilence}
        onClick={() => invoke("insert-silence", silenceFrames)}
      >
        Insert silence
      </Button>
      {!validSilence && info && (
        <span id={errorId} role="alert" className="text-xs text-destructive">
          Enter a positive whole frame count within the safe document size.
        </span>
      )}
    </fieldset>
  );
}

export function PasteConversionDialog({
  plan,
  onConfirm,
  onCancel,
}: {
  plan?: PastePlan;
  onConfirm(): void;
  onCancel(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const node = dialog.current;
    if (!plan || !node) return;
    node.showModal();
    return () => node.close();
  }, [plan]);
  if (!plan) return null;
  const mapping =
    plan.sourceChannels === plan.targetChannels
      ? undefined
      : plan.sourceChannels === 1
        ? "Mono is copied to every selected channel."
        : plan.targetChannels === 1
          ? "Source channels are averaged into the selected mono channel."
          : plan.sourceChannels > plan.targetChannels
            ? "Source channels fold cyclically into selected channels; contributors to each channel are averaged."
            : "Source channels repeat cyclically across the selected channels.";
  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className="m-auto max-w-md rounded border bg-background p-5 text-foreground backdrop:bg-black/50"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id={titleId} className="font-semibold">
        Convert clipboard
      </h2>
      <p id={descriptionId} className="my-3 text-sm">
        Convert {plan.sourceRate} Hz / {plan.sourceChannels} channels to {plan.targetRate} Hz /{" "}
        {plan.targetChannels} channels before pasting? The original clipboard is preserved.
        {mapping && <span className="mt-2 block">{mapping}</span>}
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onConfirm}>Convert and paste</Button>
      </div>
    </dialog>
  );
}
