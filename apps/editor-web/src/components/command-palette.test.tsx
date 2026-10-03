import { cleanup, fireEvent, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandId, ResolvedCommand } from "@/lib/commands";
import { CommandPalette } from "./command-palette";

const commands: readonly ResolvedCommand[] = [
  {
    id: "file.open",
    label: "Open…",
    menu: "File",
    shortcutLabel: "Ctrl+O",
    ariaShortcut: "Control+O",
    enabled: true,
  },
  { id: "edit.copy", label: "Copy", menu: "Edit", shortcutLabel: "Ctrl+C", enabled: true },
  { id: "process.normalize", label: "Normalize…", menu: "Process", enabled: false },
  { id: "view.zoom-in", label: "Zoom In", menu: "View", shortcutLabel: "Ctrl+=", enabled: true },
];

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
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mounted(initialCommands = commands, strict = false) {
  const props = {
    open: false,
    commands: initialCommands,
    onOpenChange: vi.fn(),
    onExecute: vi.fn(),
  };
  const view = render(
    <>
      <button type="button">Launcher</button>
      <CommandPalette {...props} />
    </>,
    { wrapper: strict ? StrictMode : undefined },
  );
  const launcher = view.getByRole("button", { name: "Launcher" });
  launcher.focus();
  const rerender = (changes: Partial<typeof props>) =>
    view.rerender(
      <>
        <button type="button">Launcher</button>
        <CommandPalette {...props} open {...changes} />
      </>,
    );
  rerender({ open: true });
  return {
    ...view,
    props,
    rerender,
    launcher,
    search: view.getByRole("combobox", { name: "Search commands" }) as HTMLInputElement,
  };
}

function active(search: HTMLElement) {
  const id = search.getAttribute("aria-activedescendant");
  return id ? document.getElementById(id)?.dataset.commandId : undefined;
}

describe("CommandPalette", () => {
  it("opens a native modal with a focused combobox and coherent accessible listbox linkage", () => {
    const { getByRole, search } = mounted();
    const dialog = getByRole("dialog", { name: "Command palette" });
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(search);
    expect(search.getAttribute("aria-expanded")).toBe("true");
    expect(search.getAttribute("aria-controls")).toBe(
      getByRole("listbox", { name: "Commands" }).id,
    );
    expect(active(search)).toBe("file.open");
    expect(getByRole("option", { name: /Normalize/ }).getAttribute("aria-disabled")).toBe("true");
    expect(getByRole("option", { name: /Open/ }).getAttribute("aria-keyshortcuts")).toBe(
      "Control+O",
    );
    expect(getByRole("status").textContent).toBe("4 commands");
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
  });

  it.each([
    ["  cOpY  ", "edit.copy"],
    ["view zoom", "view.zoom-in"],
    ["ctrl+o", "file.open"],
    ["process", "process.normalize"],
  ] as const)("searches normalized label/menu/shortcut terms %j", (query, commandId) => {
    const { search, getAllByRole } = mounted();
    fireEvent.change(search, { target: { value: query } });
    expect(getAllByRole("option").map((option) => option.dataset.commandId)).toEqual([commandId]);
  });

  it("matches accent-insensitive multiword labels", () => {
    const { search, getAllByRole } = mounted(
      commands.map((command) =>
        command.id === "edit.copy" ? { ...command, label: "Édit: Copy" } : command,
      ),
    );
    fireEvent.change(search, { target: { value: "edit copy" } });
    expect(getAllByRole("option").map((option) => option.dataset.commandId)).toEqual(["edit.copy"]);
  });

  it("skips disabled entries, wraps arrow navigation, and supports Home/End", () => {
    const { search } = mounted();
    const keys: [string, CommandId][] = [
      ["ArrowDown", "edit.copy"],
      ["ArrowDown", "view.zoom-in"],
      ["ArrowDown", "file.open"],
      ["ArrowUp", "view.zoom-in"],
      ["Home", "file.open"],
      ["End", "view.zoom-in"],
    ];
    for (const [key, commandId] of keys) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      fireEvent(search, event);
      expect(event.defaultPrevented).toBe(true);
      expect(active(search)).toBe(commandId);
    }
  });

  it("executes the active ID once on Enter after restoring focus synchronously", () => {
    const { search, props, launcher } = mounted();
    props.onExecute.mockImplementation(() => expect(document.activeElement).toBe(launcher));
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(props.onExecute).toHaveBeenCalledExactlyOnceWith("edit.copy");
    expect(props.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(HTMLDialogElement.prototype.close).toHaveBeenCalledOnce();
    // Even before a controlled parent rerenders, a second event cannot execute.
    fireEvent.keyDown(search, { key: "Enter" });
    expect(props.onExecute).toHaveBeenCalledOnce();
  });

  it("executes an enabled pointer option without moving focus out of the combobox first", () => {
    const { search, getByRole, props } = mounted();
    const option = getByRole("option", { name: /^Copy/ });
    fireEvent.pointerMove(option);
    expect(active(search)).toBe("edit.copy");
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    fireEvent(option, event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(search);
    fireEvent.click(option);
    expect(props.onExecute).toHaveBeenCalledExactlyOnceWith("edit.copy");
  });

  it("keeps planned/disabled results discoverable without executing or dismissing", () => {
    const { search, getByRole, props } = mounted();
    fireEvent.change(search, { target: { value: "normalize" } });
    const option = getByRole("option", { name: /Normalize/ });
    fireEvent.pointerMove(option);
    fireEvent.click(option);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(active(search)).toBeUndefined();
    expect(getByRole("status").textContent).toBe("1 command · none available");
    expect(props.onExecute).not.toHaveBeenCalled();
    expect(props.onOpenChange).not.toHaveBeenCalled();
    expect(getByRole("dialog")).toBeTruthy();
  });

  it("renders empty search results with no dangling active descendant or Enter dispatch", () => {
    const { search, queryAllByRole, getByRole, props } = mounted();
    fireEvent.change(search, { target: { value: "does not exist" } });
    expect(queryAllByRole("option")).toEqual([]);
    expect(getByRole("status").textContent).toBe("No matching commands.");
    expect(search.hasAttribute("aria-activedescendant")).toBe(false);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(props.onExecute).not.toHaveBeenCalled();
  });

  it("reflects live enabled-state changes without executing a now-disabled command", () => {
    const { search, getByRole, props, rerender } = mounted();
    fireEvent.change(search, { target: { value: "copy" } });
    expect(active(search)).toBe("edit.copy");
    rerender({ commands: commands.map((command) => ({ ...command, enabled: false })) });
    expect(active(search)).toBeUndefined();
    fireEvent.keyDown(search, { key: "Enter" });
    fireEvent.click(getByRole("option", { name: /^Copy/ }));
    expect(props.onExecute).not.toHaveBeenCalled();
    rerender({ commands });
    expect(active(search)).toBe("edit.copy");
    fireEvent.keyDown(search, { key: "Enter" });
    expect(props.onExecute).toHaveBeenCalledExactlyOnceWith("edit.copy");
  });

  it("retains highlighted identity when labels/order change and resets it when search changes", () => {
    const { search, getByRole, rerender } = mounted();
    fireEvent.pointerMove(getByRole("option", { name: /^Copy/ }));
    rerender({
      commands: [...commands]
        .reverse()
        .map((command) => ({ ...command, label: `${command.label} updated` })),
    });
    expect(active(search)).toBe("edit.copy");
    fireEvent.change(search, { target: { value: "view" } });
    expect(active(search)).toBe("view.zoom-in");
  });

  it.each(["Escape", "cancel", "button"])("dismisses via %s and restores the opener", (mode) => {
    const { search, getByRole, props, launcher } = mounted();
    if (mode === "Escape") fireEvent.keyDown(search, { key: "Escape" });
    else if (mode === "cancel") {
      const event = new Event("cancel", { cancelable: true, bubbles: true });
      fireEvent(getByRole("dialog"), event);
      expect(event.defaultPrevented).toBe(true);
    } else fireEvent.click(getByRole("button", { name: "Close command palette" }));
    expect(props.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(document.activeElement).toBe(launcher);
    expect(props.onExecute).not.toHaveBeenCalled();
  });

  it("handles Escape when focus is on the close control", () => {
    const { getByRole, props } = mounted();
    const close = getByRole("button", { name: "Close command palette" });
    close.focus();
    fireEvent.keyDown(close, { key: "Escape" });
    expect(props.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("dismisses outside backdrop clicks but not dialog surface/content clicks", () => {
    const { getByRole, props } = mounted();
    const dialog = getByRole("dialog");
    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 100,
      right: 500,
      bottom: 400,
      width: 400,
      height: 300,
      x: 100,
      y: 100,
      toJSON: () => ({}),
    });
    fireEvent.click(dialog, { clientX: 200, clientY: 200 });
    fireEvent.click(getByRole("heading", { name: "Command palette" }), {
      clientX: 200,
      clientY: 200,
    });
    expect(props.onOpenChange).not.toHaveBeenCalled();
    fireEvent.click(dialog, { clientX: 50, clientY: 50 });
    expect(props.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("ignores composing keyboard events and does not intercept ordinary typing", () => {
    const { search, props } = mounted();
    for (const key of ["Enter", "Escape", "ArrowDown"])
      fireEvent.keyDown(search, { key, isComposing: true });
    const typing = new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true });
    fireEvent(search, typing);
    expect(typing.defaultPrevented).toBe(false);
    expect(active(search)).toBe("file.open");
    expect(props.onExecute).not.toHaveBeenCalled();
    expect(props.onOpenChange).not.toHaveBeenCalled();
  });

  it("resets search on reopening and restores the new opener rather than the previous session", () => {
    const { search, props, launcher, rerender, getByRole } = mounted();
    fireEvent.change(search, { target: { value: "copy" } });
    fireEvent.keyDown(search, { key: "Escape" });
    rerender({ open: false });
    const other = document.createElement("button");
    document.body.append(other);
    other.focus();
    rerender({ open: true });
    expect((getByRole("combobox") as HTMLInputElement).value).toBe("");
    fireEvent.click(getByRole("button", { name: "Close command palette" }));
    expect(document.activeElement).toBe(other);
    expect(document.activeElement).not.toBe(launcher);
    expect(props.onOpenChange).toHaveBeenCalledTimes(2);
    other.remove();
  });

  it("closes/restores on controlled close and unmount, without redundant controlled callbacks", () => {
    const { props, launcher, rerender, unmount } = mounted();
    rerender({ open: false });
    expect(document.activeElement).toBe(launcher);
    expect(props.onOpenChange).not.toHaveBeenCalled();
    rerender({ open: true });
    unmount();
    expect(HTMLDialogElement.prototype.close).toHaveBeenCalledTimes(2);
    expect(props.onOpenChange).not.toHaveBeenCalled();
  });

  it("never steals focus back after a command opens a new dialog/control", () => {
    const { props, search, rerender } = mounted();
    const destination = document.createElement("input");
    document.body.append(destination);
    props.onExecute.mockImplementation(() => destination.focus());
    fireEvent.keyDown(search, { key: "Enter" });
    expect(document.activeElement).toBe(destination);
    rerender({ open: false });
    expect(document.activeElement).toBe(destination);
    destination.remove();
  });

  it("reports a native external close only once and tolerates a removed opener", () => {
    const { getByRole, props, launcher, search } = mounted();
    const dialog = getByRole("dialog") as HTMLDialogElement;
    const parent = launcher.parentElement;
    launcher.remove();
    dialog.close();
    fireEvent(dialog, new Event("close"));
    fireEvent(dialog, new Event("close"));
    fireEvent.keyDown(search, { key: "Enter" });
    expect(props.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(props.onExecute).not.toHaveBeenCalled();
    parent?.append(launcher);
  });

  it("supports StrictMode setup/cleanup without double command dispatch", () => {
    const { props, search } = mounted(commands, true);
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(props.onExecute).toHaveBeenCalledExactlyOnceWith("file.open");
  });

  it("survives StrictMode initially-open effect replay and restores an external opener on unmount", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const props = { commands, open: true, onOpenChange: vi.fn(), onExecute: vi.fn() };
    const { getByRole, unmount } = render(
      <StrictMode>
        <CommandPalette {...props} />
      </StrictMode>,
    );
    expect(document.activeElement).toBe(getByRole("combobox", { name: "Search commands" }));
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(2);
    unmount();
    expect(document.activeElement).toBe(opener);
    expect(props.onOpenChange).not.toHaveBeenCalled();
    opener.remove();
  });
});
