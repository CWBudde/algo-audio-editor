import { useCallback, useEffect, useRef } from "react";
import {
  type CommandActions,
  type CommandContext,
  type CommandId,
  detectShortcutPlatform,
  matchCommandShortcut,
  resolveCommands,
  type ShortcutPlatform,
} from "@/lib/commands";

export interface CommandsOptions {
  getContext(): CommandContext;
  actions: CommandActions;
  platform?: ShortcutPlatform;
  paletteOpen?: boolean;
  onError?(id: CommandId, error: unknown): void;
}

function isTextTarget(target: Element): boolean {
  return Boolean(
    target.closest(
      "input, textarea, select, [role='textbox'], [contenteditable]:not([contenteditable='false'])",
    ),
  );
}

function menuActive(target: Element | undefined): boolean {
  // Base UI keeps closed popups mounted while their exit animation runs.
  // Presence alone is not an open-menu signal, including on the trigger.
  return Boolean(
    target?.closest("[role='menu']:not([data-closed]):not([data-state='closed']):not([hidden])") ||
      document.querySelector("[role='menu'][data-open], [role='menubar'] [aria-expanded='true']"),
  );
}

/** Single keyboard dispatcher; all execution paths revalidate current controls. */
export function useCommands(options: CommandsOptions) {
  const latest = useRef(options);
  latest.current = options;
  const mounted = useRef(false);
  const platform = options.platform ?? detectShortcutPlatform();
  const commands = resolveCommands(options.getContext(), platform, options.actions);

  const execute = useCallback((id: CommandId): boolean => {
    if (!mounted.current) return false;
    const current = latest.current;
    const enabled = resolveCommands(
      current.getContext(),
      current.platform ?? detectShortcutPlatform(),
      current.actions,
    ).find((command) => command.id === id)?.enabled;
    const action = current.actions[id];
    if (!enabled || !action) return false;
    const report = (error: unknown) => {
      try {
        latest.current.onError?.(id, error);
      } catch {
        /* Error reporters must not create an unhandled rejection. */
      }
    };
    try {
      const result = action();
      if (result) void Promise.resolve(result).catch(report);
    } catch (error) {
      report(error);
    }
    return true;
  }, []);

  useEffect(() => {
    mounted.current = true;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      const current = latest.current;
      const match = matchCommandShortcut(event, current.platform ?? detectShortcutPlatform());
      if (!match) return;
      const target = event.target instanceof Element ? event.target : undefined;
      const context = current.getContext();
      const paletteToggle =
        match.id === "commands.palette" && current.paletteOpen && !context.modalOpen;
      if (
        !paletteToggle &&
        (context.modalOpen ||
          document.querySelector(
            "dialog[open], [role='dialog'][aria-modal='true']:not([hidden])",
          ) ||
          menuActive(target))
      )
        return;
      if (target && isTextTarget(target) && !match.globalInText) return;
      if (
        match.id === "transport.toggle-playback" &&
        target?.closest(
          "button, a[href], summary, [role='button'], [role='link'], [role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio']",
        )
      )
        return;
      // Disabled implemented bindings still reserve editor/browser shortcuts;
      // native text scope and planned commands above remain untouched.
      event.preventDefault();
      if (event.repeat && !match.allowRepeat) return;
      execute(match.id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      mounted.current = false;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [execute]);

  return { commands, execute };
}
