import { useId, useLayoutEffect, useRef } from "react";
import type { useAutomation } from "@/hooks/use-automation";

export function AutomationDialog({
  automation,
  canReplay,
}: {
  automation: ReturnType<typeof useAutomation>;
  canReplay: boolean;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    if (!automation.open) return;
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.showModal();
    return () => {
      dialog.current?.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [automation.open]);
  const disabled = automation.working || automation.recording;
  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${id}-title`}
      aria-modal="true"
      className="m-auto max-h-[85vh] w-[min(42rem,calc(100vw-2rem))] overflow-auto rounded-lg border bg-popover p-5 text-popover-foreground shadow-xl backdrop:bg-black/50"
      onCancel={(event) => {
        event.preventDefault();
        if (automation.working) {
          if (!automation.progress?.committing) automation.cancel();
        } else automation.close();
      }}
    >
      <h2 id={`${id}-title`} className="text-lg font-medium">
        Macros and automation
      </h2>
      <p className="my-2 text-sm text-muted-foreground">
        Record applied edits, processing and effects, then reuse the JSON chain here or with the
        native CLI. Previews, Undo, markers and metadata are excluded. Recording a new macro
        replaces this chain.
      </p>
      <p className="my-2 text-sm text-muted-foreground">
        Whole-document steps adapt to each file. Partial selections retain sample coordinates.
        Replay adds one history entry per changed step; cancellation or failure keeps completed
        changes. Loaded impulse responses and noise profiles cannot be recorded.
      </p>
      {automation.error && (
        <p role="alert" className="my-2 break-words text-destructive">
          {automation.error}
        </p>
      )}
      <p role="status" className="my-3 text-sm">
        {automation.recording
          ? "Recording applied operations"
          : `${automation.chain.operations.length} operation${automation.chain.operations.length === 1 ? "" : "s"}`}
        {automation.progress
          ? ` · ${automation.progress.completed} of ${automation.progress.total} completed${automation.working && automation.progress.committing ? " · Committing" : automation.working && automation.progress.job ? ` · ${automation.progress.job.phase}` : ""}`
          : ""}
      </p>
      <ol className="my-3 max-h-64 list-decimal overflow-auto pl-6 text-sm">
        {automation.chain.operations.map((operation, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: This read-only list has no row state; its ordinal identifies the chain step.
          <li key={`${index}-${operation.method}`} className="my-1 break-words">
            {operation.method === "effects.apply" ? "Effects" : operation.params.operation} ·{" "}
            {operation.range === "document" ? "Whole document" : "Selection / sample coordinates"}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2 text-sm">
        {automation.recording ? (
          <button
            className="rounded border px-3 py-2"
            type="button"
            onClick={automation.stopRecording}
          >
            Stop recording
          </button>
        ) : (
          <button
            className="rounded border px-3 py-2"
            type="button"
            disabled={automation.working || !canReplay}
            onClick={automation.startRecording}
          >
            Record new macro
          </button>
        )}
        <label className={`rounded border px-3 py-2 ${disabled ? "opacity-50" : "cursor-pointer"}`}>
          Import chain
          <input
            aria-label="Import chain"
            className="sr-only"
            type="file"
            accept=".json,application/json"
            disabled={disabled}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void automation.load(file);
            }}
          />
        </label>
        <button
          className="rounded border px-3 py-2"
          type="button"
          disabled={disabled || !automation.chain.operations.length}
          onClick={() => void automation.save()}
        >
          Export chain
        </button>
        <button
          className="rounded bg-primary px-3 py-2 text-primary-foreground"
          type="button"
          disabled={disabled || !canReplay || !automation.chain.operations.length}
          onClick={() => void automation.replay()}
        >
          Apply macro
        </button>
        {automation.working && automation.progress && (
          <button
            className="rounded border px-3 py-2"
            type="button"
            disabled={automation.progress.committing}
            onClick={automation.cancel}
          >
            Cancel replay
          </button>
        )}
        <button
          className="ml-auto rounded border px-3 py-2"
          type="button"
          disabled={automation.working}
          onClick={automation.close}
        >
          Close
        </button>
      </div>
    </dialog>
  );
}
