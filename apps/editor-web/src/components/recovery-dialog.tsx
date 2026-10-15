import { useId, useRef, useState } from "react";
import { useRestoringModal } from "@/hooks/use-restoring-modal";
import type { RecoverableSession } from "@/kernel/autosave/types";

function duration(session: RecoverableSession) {
  const seconds = Math.round(session.frames / session.sampleRate);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Offers the autosaved work of windows that closed unexpectedly. Discarding
 * asks once more, because it deletes the only copy of those changes.
 */
export function RecoveryDialog({
  sessions,
  open,
  progress,
  busy,
  onRecover,
  onDiscard,
  onClose,
}: {
  sessions: RecoverableSession[];
  open: boolean;
  /** Fraction of the recovery read so far, while one runs. */
  progress?: number;
  busy: boolean;
  onRecover(sessionId: string): void;
  onDiscard(sessionId: string): void;
  onClose(): void;
}) {
  const id = useId();
  const later = useRef<HTMLButtonElement>(null);
  const dialog = useRestoringModal(open, later);
  const [confirming, setConfirming] = useState<string>();
  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      aria-modal="true"
      data-testid="recovery-dialog"
      className="studio-dialog m-auto max-h-[calc(100dvh-2rem)] w-[min(32rem,calc(100vw-2rem))] overflow-y-auto border p-5 text-popover-foreground backdrop:bg-background/75 backdrop:backdrop-blur-[2px]"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClose={() => {
        if (!dialog.current?.open) onClose();
      }}
    >
      <h2 id={`${id}-title`} className="studio-dialog-heading text-lg font-semibold tracking-tight">
        Recover unsaved work
      </h2>
      <p id={`${id}-description`} className="mt-2 text-sm text-muted-foreground">
        The editor closed unexpectedly. Autosave kept the changes below; recovered documents open
        with unsaved changes and fresh undo history.
      </p>
      {open && (
        <ul className="mt-3 space-y-2" aria-label="Autosaved documents">
          {sessions.map((session) => (
            <li
              key={session.sessionId}
              className="flex flex-wrap items-center gap-2 border p-3"
              data-testid="recovery-session"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={session.name}>
                  {session.name}
                </p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {duration(session)} · {session.channels}{" "}
                  {session.channels === 1 ? "channel" : "channels"} · {session.sampleRate} Hz ·
                  saved {new Date(session.savedAt).toLocaleString()}
                </p>
              </div>
              {confirming === session.sessionId ? (
                <fieldset className="m-0 flex gap-2 border-0 p-0" aria-label="Confirm discard">
                  <button
                    type="button"
                    className="studio-button border px-3 py-1.5 text-sm"
                    onClick={() => setConfirming(undefined)}
                  >
                    Keep
                  </button>
                  <button
                    type="button"
                    className="studio-button border border-destructive px-3 py-1.5 text-sm text-destructive"
                    disabled={busy}
                    onClick={() => {
                      setConfirming(undefined);
                      onDiscard(session.sessionId);
                    }}
                  >
                    Delete permanently
                  </button>
                </fieldset>
              ) : (
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="studio-button border px-3 py-1.5 text-sm"
                    disabled={busy}
                    onClick={() => setConfirming(session.sessionId)}
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    className="studio-button studio-button-primary border px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
                    disabled={busy}
                    onClick={() => onRecover(session.sessionId)}
                  >
                    Recover
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {progress !== undefined && (
        <label className="mt-3 block text-xs text-muted-foreground">
          Recovering…
          <progress className="mt-1 block w-full" max={1} value={progress} />
        </label>
      )}
      <div className="studio-dialog-actions mt-3 flex justify-end gap-2 border-t pt-3">
        <button
          ref={later}
          type="button"
          className="studio-button border px-3 py-2 text-sm"
          disabled={busy}
          onClick={onClose}
        >
          Decide later
        </button>
      </div>
    </dialog>
  );
}
