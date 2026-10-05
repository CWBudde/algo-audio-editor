import type { HistoryListResult } from "@aae/protocol";
import { ControlDisclosure } from "@/components/control-disclosure";
import { Button } from "@/components/ui/button";
import type { CommandId, ResolvedCommand } from "@/lib/commands";
import { formatBytes } from "@/lib/format-bytes";
import { History } from "@/lib/icons";

export interface HistoryPanelProps {
  history?: HistoryListResult;
  busy?: boolean;
  frameless?: boolean;
  commands?: readonly ResolvedCommand[];
  onExecute?(id: CommandId): void;
  onUndo(): void;
  onRedo(): void;
  onJump(stateId: string): void;
}

export function HistoryPanel({
  history,
  busy,
  frameless,
  commands,
  onExecute,
  onUndo,
  onRedo,
  onJump,
}: HistoryPanelProps) {
  const current =
    history?.entries.findIndex((entry) => entry.stateId === history.currentStateId) ?? -1;
  return (
    <aside
      aria-label="Edit history"
      className={frameless ? "border-l pl-2 text-xs" : "border-b px-2 py-1 text-xs"}
    >
      <ControlDisclosure className="relative">
        <summary
          className="flex size-7 cursor-pointer list-none items-center justify-center rounded-md hover:bg-muted focus-visible:outline-ring"
          title="Edit history"
        >
          <History className="size-4" aria-hidden="true" />
          <span className="sr-only">Edit history</span>
        </summary>
        <div
          data-disclosure-panel
          className="absolute right-0 top-full z-40 mt-1 w-80 max-w-[calc(100vw-1rem)] rounded-md border bg-popover p-3 text-popover-foreground shadow-lg"
        >
          <p className="font-medium">
            Edit history ·{" "}
            <span data-testid="history-dirty">
              {history ? (history.dirty ? "Unsaved changes" : "Saved") : "No document"}
            </span>
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={
                commands
                  ? !commands.find((command) => command.id === "edit.undo")?.enabled
                  : busy || !history?.canUndo
              }
              onClick={() => (onExecute ? onExecute("edit.undo") : onUndo())}
            >
              Undo edit
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={
                commands
                  ? !commands.find((command) => command.id === "edit.redo")?.enabled
                  : busy || !history?.canRedo
              }
              onClick={() => (onExecute ? onExecute("edit.redo") : onRedo())}
            >
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
        </div>
      </ControlDisclosure>
    </aside>
  );
}
