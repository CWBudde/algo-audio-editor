import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarTrigger,
} from "@/components/ui/menubar";
import { COMMAND_MENUS, type CommandId, type ResolvedCommand } from "@/lib/commands";

interface AppMenubarProps {
  commands: readonly ResolvedCommand[];
  onExecute(id: CommandId): void;
}

export function AppMenubar({ commands, onExecute }: AppMenubarProps) {
  const byId = new Map(commands.map((command) => [command.id, command]));
  return (
    <Menubar className="h-8 min-w-0 flex-1 overflow-x-auto rounded-none border-0 bg-transparent p-0 shadow-none">
      {COMMAND_MENUS.map((menu) => (
        <MenubarMenu key={menu.label}>
          <MenubarTrigger className="shrink-0">{menu.label}</MenubarTrigger>
          <MenubarContent>
            {(menu.label === "Effects"
              ? commands
                  .filter((command) => command.menu === "Effects")
                  .map((command) => command.id)
              : menu.items
            ).map((item, i) => {
              if (item === "-")
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static list, separators have no identity
                  <MenubarSeparator key={`sep-${i}`} />
                );
              const command = byId.get(item);
              if (!command) return null;
              return (
                <MenubarItem
                  key={command.id}
                  data-command-id={command.id}
                  disabled={!command.enabled}
                  aria-keyshortcuts={command.ariaShortcut}
                  onClick={() => {
                    if (command.enabled) onExecute(command.id);
                  }}
                >
                  {command.label}
                  {command.shortcutLabel && (
                    <MenubarShortcut>{command.shortcutLabel}</MenubarShortcut>
                  )}
                </MenubarItem>
              );
            })}
          </MenubarContent>
        </MenubarMenu>
      ))}
    </Menubar>
  );
}
