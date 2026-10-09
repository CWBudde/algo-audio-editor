import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commandShortcuts } from "@/lib/commands";
import { ShortcutsDialog } from "./shortcuts-dialog";

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.open = true;
    }),
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.open = false;
    }),
  });
});
afterEach(cleanup);

function keys(row: HTMLElement) {
  return within(row)
    .getAllByTestId("shortcut-key")
    .map((key) => key.textContent);
}

it("lists every registered shortcut, grouped by menu, with the platform's key labels", () => {
  const ui = render(<ShortcutsDialog open platform="other" onClose={vi.fn()} />);
  const dialog = ui.getByRole("dialog", { name: "Keyboard shortcuts" });
  for (const group of commandShortcuts("other")) {
    const section = within(dialog).getByRole("region", { name: group.menu });
    for (const command of group.commands) {
      const row = within(section).getByTestId(`shortcut-${command.id}`);
      expect(row.textContent).toContain(command.label);
      expect(keys(row)).toEqual(command.keys);
    }
  }
  expect(keys(ui.getByTestId("shortcut-edit.redo"))).toEqual(["Ctrl+Shift+Z", "Ctrl+Y"]);
});

it("shows Cmd labels and drops other-platform alternatives on macOS", () => {
  const ui = render(<ShortcutsDialog open platform="mac" onClose={vi.fn()} />);
  expect(keys(ui.getByTestId("shortcut-edit.redo"))).toEqual(["Cmd+Shift+Z"]);
});

it("closes from the Close button and from Escape", () => {
  const onClose = vi.fn();
  const ui = render(<ShortcutsDialog open platform="other" onClose={onClose} />);
  fireEvent.click(ui.getByRole("button", { name: "Close keyboard shortcuts" }));
  fireEvent(ui.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(onClose).toHaveBeenCalledTimes(2);
});
