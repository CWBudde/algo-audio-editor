import type { HistoryListResult } from "@aae/protocol";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format-bytes";

export interface HistoryPanelProps {
  history?: HistoryListResult;
  busy?: boolean;
  onUndo(): void;
  onRedo(): void;
  onJump(stateId: string): void;
}

export function HistoryPanel({ history, busy, onUndo, onRedo, onJump }: HistoryPanelProps) {
  const current =
    history?.entries.findIndex((entry) => entry.stateId === history.currentStateId) ?? -1;
  return (
    <aside aria-label="Edit history" className="border-b px-3 py-1.5 text-xs">
      <details>
        <summary className="cursor-pointer select-none">
          Edit history ·{" "}
          <span data-testid="history-dirty">
            {history ? (history.dirty ? "Unsaved changes" : "Saved") : "No document"}
          </span>
        </summary>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="xs" variant="outline" disabled={busy || !history?.canUndo} onClick={onUndo}>
            Undo edit
          </Button>
          <Button size="xs" variant="outline" disabled={busy || !history?.canRedo} onClick={onRedo}>
            Redo edit
          </Button>
          {history && (
            <span data-testid="history-budget" className="text-muted-foreground">
              {history.entries.length} states · limit {history.maxEntries} edits · retained{" "}
              {formatBytes(history.retainedBytes)} / {formatBytes(history.maxBytes)}
            </span>
          )}
        </div>
        <ol aria-label="History states" className="mt-2 max-h-36 overflow-y-auto">
          {history?.entries.map((entry, index) => {
            const isCurrent = entry.stateId === history.currentStateId;
            const saved = entry.stateId === history.savedStateId;
            const redo = current >= 0 && index > current;
            return (
              <li key={entry.stateId} className="my-1">
                <button
                  type="button"
                  aria-label={`Go to ${entry.label}`}
                  aria-current={isCurrent ? "step" : undefined}
                  disabled={busy || isCurrent}
                  data-testid={`history-state-${entry.stateId}`}
                  data-current={String(isCurrent)}
                  data-saved={String(saved)}
                  data-redo={String(redo)}
                  className="w-full rounded border px-2 py-1 text-left disabled:opacity-60"
                  onClick={() => {
                    if (!busy && !isCurrent) onJump(entry.stateId);
                  }}
                >
                  {entry.label}
                  {isCurrent && " · Current"}
                  {saved && " · Saved"}
                  {redo && " · Redo"}
                </button>
              </li>
            );
          })}
        </ol>
      </details>
    </aside>
  );
}
