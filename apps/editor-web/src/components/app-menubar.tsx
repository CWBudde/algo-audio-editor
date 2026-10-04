import { useRef } from "react";
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from "@/components/ui/menubar";
import { COMMAND_MENUS, type CommandId, type ResolvedCommand } from "@/lib/commands";
import { EFFECT_MENU_CATEGORIES } from "@/lib/effect-menu";

interface AppMenubarProps {
  commands: readonly ResolvedCommand[];
  onExecute(id: CommandId): void;
}

export function AppMenubar({ commands, onExecute }: AppMenubarProps) {
  const effectsTrigger = useRef<HTMLButtonElement>(null);
  const byId = new Map(commands.map((command) => [command.id, command]));
  const effectCommands = commands.filter((command) => command.menu === "Effects");
  const effectGroups = EFFECT_MENU_CATEGORIES.map((category) => ({
    category,
    commands: effectCommands.filter((command) => command.submenu === category),
  })).filter((group) => group.commands.length > 0);
  const renderCommand = (command: ResolvedCommand) => (
    <MenubarItem
      key={command.id}
      data-command-id={command.id}
      disabled={!command.enabled}
      aria-keyshortcuts={command.ariaShortcut}
      onClick={() => {
        if (!command.enabled) return;
        if (command.menu === "Effects") {
          // Let submenu selection settle before giving the dialog a persistent opener.
          queueMicrotask(() => {
            if (!effectsTrigger.current) return;
            effectsTrigger.current.focus({ preventScroll: true });
            onExecute(command.id);
          });
        } else {
          onExecute(command.id);
        }
      }}
    >
      {command.label}
      {command.shortcutLabel && <MenubarShortcut>{command.shortcutLabel}</MenubarShortcut>}
    </MenubarItem>
  );
  return (
    <Menubar className="h-8 min-w-0 flex-1 overflow-x-auto rounded-none border-0 bg-transparent p-0 shadow-none">
      {COMMAND_MENUS.map((menu) => (
        <MenubarMenu key={menu.label}>
          <MenubarTrigger
            ref={menu.label === "Effects" ? effectsTrigger : undefined}
            className="shrink-0"
          >
            {menu.label}
          </MenubarTrigger>
          <MenubarContent>
            {menu.label === "Effects" ? (
              <>
                {effectCommands.filter((command) => !command.submenu).map(renderCommand)}
                {effectGroups.length > 0 && <MenubarSeparator />}
                {effectGroups.map((group) => (
                  <MenubarSub key={group.category}>
                    <MenubarSubTrigger>{group.category}</MenubarSubTrigger>
                    <MenubarSubContent>{group.commands.map(renderCommand)}</MenubarSubContent>
                  </MenubarSub>
                ))}
              </>
            ) : (
              menu.items.map((item, i) => {
                if (item === "-")
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: static list, separators have no identity
                    <MenubarSeparator key={`sep-${i}`} />
                  );
                const command = byId.get(item);
                return command ? renderCommand(command) : null;
              })
            )}
          </MenubarContent>
        </MenubarMenu>
      ))}
    </Menubar>
  );
}
