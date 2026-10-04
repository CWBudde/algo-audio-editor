import { COMMAND_MENUS, type ResolvedCommand } from "@/lib/commands";
import { EFFECT_MENU_CATEGORIES } from "@/lib/effect-menu";
import type { NativeMenuItem } from "@/platform";

export function nativeMenu(commands: readonly ResolvedCommand[]): NativeMenuItem[] {
  const byId = new Map(commands.map((command) => [command.id, command]));
  const item = (command: ResolvedCommand): NativeMenuItem => ({
    id: command.id,
    label: command.label,
    enabled: command.enabled,
    ...(command.ariaShortcut
      ? {
          accelerator: command.ariaShortcut
            .replace("Meta", "Command")
            .replaceAll(" ", "")
            .replace("Arrow", ""),
        }
      : {}),
  });
  return COMMAND_MENUS.map((menu) => ({
    label: menu.label,
    children:
      menu.label === "Effects"
        ? [
            ...commands
              .filter((command) => command.menu === "Effects" && !command.submenu)
              .map(item),
            { separator: true },
            ...EFFECT_MENU_CATEGORIES.flatMap((category) => {
              const children = commands
                .filter((command) => command.menu === "Effects" && command.submenu === category)
                .map(item);
              return children.length ? [{ label: category, children }] : [];
            }),
          ]
        : menu.items.flatMap((id) =>
            id === "-"
              ? [{ separator: true }]
              : byId.has(id)
                ? [item(byId.get(id) as ResolvedCommand)]
                : [],
          ),
  }));
}
