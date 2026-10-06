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
      className={
        frameless ? "editor-tool-band shrink-0 border-l pl-1 text-xs" : "border-b px-2 py-1 text-xs"
      }
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
          className="studio-dialog absolute right-0 top-full z-40 mt-2 max-h-[calc(100dvh-8rem)] w-80 max-w-[calc(100vw-1rem)] overflow-y-auto border p-3 text-popover-foreground"
        >
          <p className="text-xs font-semibold tracking-tight">
            Edit history ·{" "}
            <span data-testid="history-dirty" className="font-normal text-muted-foreground">
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
              <span
                data-testid="history-budget"
                className="text-[11px] leading-relaxed text-muted-foreground"
              >
                {history.entries.length} states · limit {history.maxEntries} edits · retained{" "}
                {formatBytes(history.retainedBytes)} / {formatBytes(history.maxBytes)}
              </span>
            )}
          </div>
          <ol
            aria-label="History states"
            className="mt-3 max-h-52 space-y-1 overflow-y-auto border-t border-border/60 pt-2"
          >
            {history?.entries.map((entry, index) => {
              const isCurrent = entry.stateId === history.currentStateId;
              const saved = entry.stateId === history.savedStateId;
              const redo = current >= 0 && index > current;
              return (
                <li key={entry.stateId} className="min-w-0">
                  <button
                    type="button"
                    aria-label={`Go to ${entry.label}`}
                    aria-current={isCurrent ? "step" : undefined}
                    disabled={busy || isCurrent}
                    data-testid={`history-state-${entry.stateId}`}
                    data-current={String(isCurrent)}
                    data-saved={String(saved)}
                    data-redo={String(redo)}
                    className="studio-button w-full break-words border px-2 py-1.5 text-left text-xs leading-relaxed disabled:opacity-60 data-[current=true]:border-primary/30 data-[current=true]:bg-primary/10 data-[current=true]:text-primary data-[current=true]:opacity-100 data-[redo=true]:text-muted-foreground"
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
