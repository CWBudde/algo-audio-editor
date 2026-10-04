import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMAND_MENUS, type ResolvedCommand } from "@/lib/commands";
import { AppMenubar } from "./app-menubar";

const commands: readonly ResolvedCommand[] = [
  { id: "file.new", label: "New…", menu: "File", enabled: false },
  {
    id: "file.open",
    label: "Choose audio…",
    menu: "File",
    shortcutLabel: "⌘O",
    ariaShortcut: "Meta+O",
    enabled: true,
  },
  { id: "file.save", label: "Save", menu: "File", enabled: false },
  { id: "file.metadata", label: "File metadata…", menu: "File", enabled: true },
  { id: "view.zoom-in", label: "Zoom In", menu: "View", enabled: true },
  { id: "help.about", label: "About this editor", menu: "Help", enabled: true },
];
afterEach(cleanup);

describe("AppMenubar", () => {
  it("uses registry menu order and resolved labels/shortcuts, keeping planned items disabled", async () => {
    const onExecute = vi.fn();
    const { getByRole, findByRole } = render(
      <AppMenubar commands={commands} onExecute={onExecute} />,
    );
    const menubar = getByRole("menubar");
    expect(
      within(menubar)
        .getAllByRole("menuitem")
        .map((trigger) => trigger.textContent),
    ).toEqual(COMMAND_MENUS.map((menu) => menu.label));
    fireEvent.click(within(menubar).getByRole("menuitem", { name: "File" }));
    const open = await findByRole("menuitem", { name: /Choose audio/ });
    expect(open.dataset.commandId).toBe("file.open");
    expect(open.getAttribute("aria-keyshortcuts")).toBe("Meta+O");
    expect(open.textContent).toContain("⌘O");
    const planned = getByRole("menuitem", { name: "New…" });
    expect(planned.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(planned);
    expect(onExecute).not.toHaveBeenCalled();
    fireEvent.click(open);
    expect(onExecute).toHaveBeenCalledExactlyOnceWith("file.open");
  });

  it("routes About through its registry ID without local toast or label-based handlers", async () => {
    const onExecute = vi.fn();
    const { getByRole, findByRole } = render(
      <AppMenubar commands={commands} onExecute={onExecute} />,
    );
    fireEvent.click(getByRole("menuitem", { name: "Help" }));
    const about = await findByRole("menuitem", { name: "About this editor" });
    fireEvent.click(about);
    expect(onExecute).toHaveBeenCalledExactlyOnceWith("help.about");
  });

  it("reflects live availability while retaining stable command identity", async () => {
    const onExecute = vi.fn();
    const { getByRole, findByRole, rerender } = render(
      <AppMenubar commands={commands} onExecute={onExecute} />,
    );
    fireEvent.click(getByRole("menuitem", { name: "File" }));
    const save = await findByRole("menuitem", { name: "Save" });
    expect(save.getAttribute("aria-disabled")).toBe("true");
    rerender(
      <AppMenubar
        commands={commands.map((command) =>
          command.id === "file.save" ? { ...command, label: "Save audio", enabled: true } : command,
        )}
        onExecute={onExecute}
      />,
    );
    const enabledSave = getByRole("menuitem", { name: "Save audio" });
    expect(enabledSave.dataset.commandId).toBe("file.save");
    expect(enabledSave.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(enabledSave);
    expect(onExecute).toHaveBeenCalledExactlyOnceWith("file.save");
  });

  it("uses registry IDs rather than caller array order for menu entries and separators", async () => {
    const { getByRole, findByRole, queryByRole } = render(
      <AppMenubar commands={[...commands].reverse()} onExecute={vi.fn()} />,
    );
    fireEvent.click(getByRole("menuitem", { name: "File" }));
    await findByRole("menuitem", { name: /Choose audio/ });
    const menu = getByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.dataset.commandId),
    ).toEqual(["file.new", "file.open", "file.save", "file.metadata"]);
    expect(within(menu).getAllByRole("separator")).toHaveLength(2);
    expect(queryByRole("menuitem", { name: "About this editor" })).toBeNull();
  });
  it("groups effects into ordered submenus while retaining rack access and live availability", async () => {
    const onExecute = vi.fn();
    const effects: ResolvedCommand[] = [
      {
        id: "effects.distortion",
        label: "Distortion…",
        menu: "Effects",
        submenu: "Color",
        enabled: false,
      },
      {
        id: "effects.chorus",
        label: "Chorus…",
        menu: "Effects",
        submenu: "Modulation",
        enabled: true,
      },
      { id: "effects.rack", label: "Effect rack…", menu: "Effects", enabled: true },
    ];
    const { getByRole, findByRole, queryByRole, rerender } = render(
      <AppMenubar commands={effects} onExecute={onExecute} />,
    );
    fireEvent.click(getByRole("menuitem", { name: "Effects" }));
    await findByRole("menuitem", { name: "Effect rack…" });
    expect(
      within(getByRole("menu"))
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Effect rack…", "Modulation", "Color"]);
    expect(queryByRole("menuitem", { name: "Distortion…" })).toBeNull();
    expect(queryByRole("menuitem", { name: "Filters" })).toBeNull();
    fireEvent.click(getByRole("menuitem", { name: "Color" }));
    const distortion = await findByRole("menuitem", { name: "Distortion…" });
    expect(distortion.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(distortion);
    expect(onExecute).not.toHaveBeenCalled();
    rerender(
      <AppMenubar
        commands={effects.map((command) => ({ ...command, enabled: true }))}
        onExecute={onExecute}
      />,
    );
    fireEvent.click(getByRole("menuitem", { name: "Distortion…" }));
    await waitFor(() => expect(onExecute).toHaveBeenCalledExactlyOnceWith("effects.distortion"));
  });
});
