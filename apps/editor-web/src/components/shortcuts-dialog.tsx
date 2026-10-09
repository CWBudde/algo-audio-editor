import { useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { useRestoringModal } from "@/hooks/use-restoring-modal";
import { commandShortcuts, type ShortcutPlatform } from "@/lib/commands";

/** Generated from the command registry, so it lists exactly what the key handler accepts. */
export function ShortcutsDialog({
  open,
  platform,
  onClose,
}: {
  open: boolean;
  platform: ShortcutPlatform;
  onClose(): void;
}) {
  const id = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRestoringModal(open, closeButton);
  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${id}-title`}
      aria-modal="true"
      data-testid="shortcuts-dialog"
      className="studio-dialog m-auto max-h-[calc(100dvh-2rem)] w-[min(34rem,calc(100vw-2rem))] overflow-y-auto border p-5 text-popover-foreground backdrop:bg-background/75 backdrop:backdrop-blur-[2px]"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={() => {
        if (!dialog.current?.open) onClose();
      }}
    >
      <h2 id={`${id}-title`} className="studio-dialog-heading text-lg font-semibold tracking-tight">
        Keyboard shortcuts
      </h2>
      <div className="mt-3 space-y-3">
        {open &&
          commandShortcuts(platform).map((group) => (
            <section
              key={group.menu}
              aria-labelledby={`${id}-${group.menu}`}
              className="studio-section border px-3 py-2 text-xs"
            >
              <h3 id={`${id}-${group.menu}`} className="mb-1 font-medium text-muted-foreground">
                {group.menu}
              </h3>
              <dl className="divide-y divide-border/50">
                {group.commands.map((command) => (
                  <div
                    key={command.id}
                    data-testid={`shortcut-${command.id}`}
                    className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-1.5"
                  >
                    <dt>{command.label}</dt>
                    <dd className="flex flex-wrap justify-end gap-1">
                      {command.keys.map((key) => (
                        <kbd
                          key={key}
                          data-testid="shortcut-key"
                          className="rounded-sm border bg-muted px-1.5 py-0.5 font-mono text-[0.7rem]"
                        >
                          {key}
                        </kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
      </div>
      <div className="studio-dialog-actions mt-4 flex justify-end border-t pt-3">
        <Button ref={closeButton} onClick={onClose} aria-label="Close keyboard shortcuts">
          Close
        </Button>
      </div>
    </dialog>
  );
}
