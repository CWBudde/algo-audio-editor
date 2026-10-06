import { type KeyboardEvent, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CommandId, ResolvedCommand } from "@/lib/commands";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  commands: readonly ResolvedCommand[];
  onExecute(id: CommandId): void;
}

function normalize(text: string) {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase().trim();
}

/** One registry, three entry points: menu, shortcuts, and this searchable view. */
export function CommandPalette({ open, onOpenChange, commands, onExecute }: CommandPaletteProps) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | undefined>(undefined);
  const shown = useRef(false);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<CommandId>();
  const latest = useRef({ commands, onExecute, onOpenChange, open });
  latest.current = { commands, onExecute, onOpenChange, open };
  const results = useMemo(() => {
    const terms = normalize(query).split(/\s+/).filter(Boolean);
    return commands.filter((command) => {
      const haystack = normalize(`${command.label} ${command.menu} ${command.shortcutLabel ?? ""}`);
      return terms.every((term) => haystack.includes(term));
    });
  }, [commands, query]);
  const enabled = results.filter((command) => command.enabled);
  const active = enabled.find((command) => command.id === activeId) ?? enabled[0];
  const activeCommandId = active?.id;
  const optionId = (commandId: CommandId) => `${id}-command-${commandId}`;
  const restoreFocus = () => {
    const previous = opener.current;
    opener.current = undefined;
    if (previous?.isConnected) previous.focus({ preventScroll: true });
  };
  const dismiss = () => {
    if (!shown.current) return;
    shown.current = false;
    if (dialog.current?.open) dialog.current.close();
    restoreFocus();
    latest.current.onOpenChange(false);
  };
  const execute = (commandId: CommandId) => {
    // Consult current props, not a stale highlighted row, before dispatching.
    const command = latest.current.commands.find((item) => item.id === commandId);
    if (!open || !shown.current || !command?.enabled) return;
    dismiss();
    latest.current.onExecute(command.id);
  };
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!open) {
      // Restore after React's commit-time focus restoration, not during its
      // mutation cleanup (which can put focus back in the hidden search input).
      const previous = opener.current;
      opener.current = undefined;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      return;
    }
    opener.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    setQuery("");
    setActiveId(undefined);
    shown.current = true;
    element.showModal();
    search.current?.focus();
    return () => {
      shown.current = false;
      if (element.open) element.close();
      if (!latest.current.open) return;
      const previous = opener.current;
      opener.current = undefined;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !activeCommandId) return;
    document
      .getElementById(`${id}-command-${activeCommandId}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeCommandId, id]);
  const navigate = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (active) execute(active.id);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!enabled.length) return;
    const current = enabled.findIndex((command) => command.id === active?.id);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? enabled.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length;
    setActiveId(enabled[next].id);
  };
  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${id}-title`}
      aria-modal="true"
      aria-describedby={`${id}-help`}
      data-testid="command-palette"
      className="studio-dialog m-auto max-h-[calc(100dvh-2rem)] w-[min(36rem,calc(100vw-2rem))] overflow-y-auto border p-0 text-popover-foreground backdrop:bg-background/75 backdrop:backdrop-blur-[2px]"
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      onClose={() => {
        if (!dialog.current?.open) dismiss();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          dismiss();
        }
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          dismiss();
      }}
    >
      <div className="flex items-center justify-between px-4 pt-3">
        <h2 id={`${id}-title`} className="studio-dialog-heading font-semibold tracking-tight">
          Command palette
        </h2>
        <button
          type="button"
          aria-label="Close command palette"
          onClick={dismiss}
          className="studio-button border px-2 py-1 text-[11px]"
        >
          Esc
        </button>
      </div>
      <p id={`${id}-help`} className="studio-dialog-help px-4 text-xs text-muted-foreground">
        Search commands. Use arrow keys to choose and Enter to run.
      </p>
      <input
        ref={search}
        role="combobox"
        aria-label="Search commands"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={`${id}-results`}
        aria-activedescendant={active ? optionId(active.id) : undefined}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveId(undefined);
        }}
        onKeyDown={navigate}
        autoComplete="off"
        spellCheck={false}
        className="studio-field m-3 w-[calc(100%-1.5rem)] border px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-ring"
      />
      <div
        id={`${id}-results`}
        role="listbox"
        aria-label="Commands"
        className="max-h-[min(24rem,calc(100dvh-14rem))] overflow-y-auto border-t p-2"
      >
        {results.map((command) => (
          <div
            key={command.id}
            id={optionId(command.id)}
            role="option"
            tabIndex={-1}
            aria-selected={active?.id === command.id}
            aria-disabled={!command.enabled}
            aria-keyshortcuts={command.ariaShortcut}
            data-command-id={command.id}
            className={`flex cursor-default items-center gap-3 rounded-md border px-3 py-2.5 ${active?.id === command.id ? "border-primary/20 bg-accent text-accent-foreground" : "border-transparent"} ${!command.enabled ? "opacity-50" : ""}`}
            onPointerMove={() => {
              if (command.enabled) setActiveId(command.id);
            }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => execute(command.id)}
            onKeyDown={(event) => {
              if ((event.key === "Enter" || event.key === " ") && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.stopPropagation();
                execute(command.id);
              }
            }}
          >
            <span className="min-w-0 flex-1">
              <span className="block break-words text-sm font-medium">{command.label}</span>
              <span className="block text-xs text-muted-foreground">
                {command.menu}
                {!command.enabled && " · unavailable"}
              </span>
            </span>
            {command.shortcutLabel && (
              <kbd className="shrink-0 rounded border border-border/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {command.shortcutLabel}
              </kbd>
            )}
          </div>
        ))}
      </div>
      <p
        role="status"
        aria-live="polite"
        className="border-t px-4 py-2 text-[11px] text-muted-foreground"
      >
        {results.length
          ? `${results.length} command${results.length === 1 ? "" : "s"}${enabled.length ? "" : " · none available"}`
          : "No matching commands."}
      </p>
    </dialog>
  );
}
