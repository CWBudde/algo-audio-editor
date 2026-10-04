import type { ClipboardInfo, DocumentInfoResult } from "@aae/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandActions, CommandContext, CommandId } from "@/lib/commands";
import { type CommandsOptions, useCommands } from "./use-commands";

const info: DocumentInfoResult = {
  documentId: "doc-1",
  name: "test.wav",
  sampleRate: 48000,
  channels: 2,
  frames: 100,
  bitDepth: 16,
  float: false,
};
const clipboard: ClipboardInfo = {
  version: "clip-1",
  available: true,
  sampleRate: 48000,
  channels: 2,
  frames: 10,
};
const base: CommandContext = {
  ready: true,
  busy: false,
  audioReady: true,
  info,
  clipboard,
  selection: { start: 10, end: 20, channelMask: 3 },
  canUndo: true,
  canRedo: true,
  playing: true,
  silenceFrames: 10,
};
const ids: CommandId[] = [
  "file.open",
  "file.save",
  "file.export",
  "edit.undo",
  "edit.redo",
  "edit.cut",
  "edit.copy",
  "edit.paste-insert",
  "edit.delete",
  "edit.select-all",
  "view.zoom-in",
  "view.zoom-out",
  "view.zoom-fit",
  "transport.toggle-playback",
  "transport.seek-start",
  "transport.seek-end",
  "commands.palette",
  "help.about",
];

function mounted(overrides: Partial<CommandsOptions> = {}, strict = false) {
  let context = { ...base };
  const actions: CommandActions = Object.fromEntries(ids.map((id) => [id, vi.fn()]));
  const options: CommandsOptions = {
    getContext: () => context,
    actions,
    platform: "other",
    onError: vi.fn(),
    ...overrides,
  };
  return {
    actions,
    options,
    setContext(value: Partial<CommandContext>) {
      context = { ...context, ...value };
    },
    ...renderHook((props: CommandsOptions) => useCommands(props), {
      initialProps: options,
      wrapper: strict ? StrictMode : undefined,
    }),
  };
}

function press(key: string, props: KeyboardEventInit = {}, target: EventTarget = window) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...props });
  act(() => target.dispatchEvent(event));
  return event;
}

function node(html: string) {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  return container.firstElementChild as HTMLElement;
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("useCommands", () => {
  it("returns registry metadata and dispatches only current enabled actions", () => {
    const { result, actions, setContext, rerender, options } = mounted();
    expect(result.current.commands.find((command) => command.id === "edit.copy")).toMatchObject({
      label: "Copy",
      enabled: true,
      shortcutLabel: "Ctrl+C",
    });
    expect(result.current.execute("edit.copy")).toBe(true);
    expect(actions["edit.copy"]).toHaveBeenCalledOnce();
    setContext({ busy: true });
    expect(result.current.execute("edit.copy")).toBe(false);
    expect(actions["edit.copy"]).toHaveBeenCalledOnce();
    expect(result.current.execute("commands.palette")).toBe(true);
    setContext({ busy: false, selection: { start: 20, end: 20, channelMask: 3 } });
    expect(result.current.execute("edit.copy")).toBe(false);
    const fresh = vi.fn();
    rerender({ ...options, actions: { ...actions, "file.open": fresh } });
    expect(result.current.execute("file.open")).toBe(true);
    expect(fresh).toHaveBeenCalledOnce();
    expect(actions["file.open"]).not.toHaveBeenCalled();
  });

  it.each(["other", "mac"] as const)(
    "dispatches platform shortcuts and rejects modifier collisions on %s",
    (platform) => {
      const { actions } = mounted({ platform });
      const primary = platform === "mac" ? { metaKey: true } : { ctrlKey: true };
      for (const [key, id] of [
        ["o", "file.open"],
        ["s", "file.save"],
        ["x", "edit.cut"],
        ["c", "edit.copy"],
        ["v", "edit.paste-insert"],
        ["a", "edit.select-all"],
        ["k", "commands.palette"],
      ] as const) {
        expect(press(key, primary).defaultPrevented).toBe(true);
        expect(actions[id]).toHaveBeenCalledOnce();
      }
      expect(press("e", { ...primary, shiftKey: true }).defaultPrevented).toBe(true);
      expect(actions["file.export"]).toHaveBeenCalledOnce();
      expect(press("z", primary).defaultPrevented).toBe(true);
      expect(press("z", { ...primary, shiftKey: true }).defaultPrevented).toBe(true);
      expect(press("y", primary).defaultPrevented).toBe(platform === "other");
      expect(actions["edit.redo"]).toHaveBeenCalledTimes(platform === "other" ? 2 : 1);
      for (const props of [
        { ...primary, altKey: true },
        { ctrlKey: true, metaKey: true },
        { ...primary, shiftKey: true },
        platform === "mac" ? { ctrlKey: true } : { metaKey: true },
      ])
        expect(press("o", props).defaultPrevented).toBe(false);
      expect(actions["file.open"]).toHaveBeenCalledOnce();
    },
  );

  it("leaves text-editing, navigation and selection shortcuts native but exposes global file/palette commands", () => {
    const { actions } = mounted();
    for (const html of [
      "<input />",
      "<textarea></textarea>",
      "<select><option>test</option></select>",
      "<div role='textbox'><span>editable</span></div>",
      "<div contenteditable='true'><span>editable</span></div>",
    ]) {
      const field = node(html);
      const target = field.firstElementChild ?? field;
      for (const [key, props] of [
        ["c", { ctrlKey: true }],
        ["x", { ctrlKey: true }],
        ["v", { ctrlKey: true }],
        ["a", { ctrlKey: true }],
        ["z", { ctrlKey: true }],
        ["z", { ctrlKey: true, shiftKey: true }],
        ["=", { ctrlKey: true }],
        ["Home", {}],
        ["End", {}],
        ["Delete", {}],
        [" ", { code: "Space" }],
      ] as const)
        expect(press(key, props, target).defaultPrevented, `${html} ${key}`).toBe(false);
      for (const [key, props] of [
        ["o", { ctrlKey: true }],
        ["s", { ctrlKey: true }],
        ["e", { ctrlKey: true, shiftKey: true }],
        ["k", { ctrlKey: true }],
      ] as const)
        expect(press(key, props, target).defaultPrevented).toBe(true);
      field.parentElement?.remove();
    }
    expect(actions["edit.copy"]).not.toHaveBeenCalled();
    expect(actions["edit.undo"]).not.toHaveBeenCalled();
    expect(actions["transport.toggle-playback"]).not.toHaveBeenCalled();
    expect(actions["file.open"]).toHaveBeenCalledTimes(5);
    expect(actions["commands.palette"]).toHaveBeenCalledTimes(5);
  });

  it("preserves Space native button/link/summary activation, including descendants", () => {
    const { actions } = mounted();
    for (const html of [
      "<button><span>button</span></button>",
      "<a href='#'><span>link</span></a>",
      "<summary><span>summary</span></summary>",
      "<div role='button'><span>button</span></div>",
      "<div role='link'><span>link</span></div>",
      "<div role='menuitem'><span>menu</span></div>",
    ]) {
      const element = node(html);
      expect(
        press(" ", { code: "Space" }, element.firstElementChild ?? element).defaultPrevented,
      ).toBe(false);
      element.parentElement?.remove();
    }
    expect(actions["transport.toggle-playback"]).not.toHaveBeenCalled();
    expect(press(" ", { code: "Space" }).defaultPrevented).toBe(true);
    expect(actions["transport.toggle-playback"]).toHaveBeenCalledOnce();
  });

  it("reserves disabled implemented bindings, ignores planned commands and suppresses nonzoom repeats", () => {
    const { actions, setContext } = mounted();
    setContext({ busy: true });
    expect(press("s", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(actions["file.save"]).not.toHaveBeenCalled();
    expect(press("n", { ctrlKey: true }).defaultPrevented).toBe(false);
    setContext({ busy: false });
    for (const [key, props] of [
      ["o", { ctrlKey: true }],
      ["z", { ctrlKey: true }],
      ["c", { ctrlKey: true }],
      ["Delete", {}],
      ["Home", {}],
      [" ", { code: "Space" }],
      ["k", { ctrlKey: true }],
    ] as const)
      expect(press(key, { ...props, repeat: true }).defaultPrevented).toBe(true);
    for (const id of [
      "file.open",
      "edit.undo",
      "edit.copy",
      "edit.delete",
      "transport.seek-start",
      "transport.toggle-playback",
      "commands.palette",
    ] as const)
      expect(actions[id]).not.toHaveBeenCalled();
    for (const [key, id] of [
      ["=", "view.zoom-in"],
      ["-", "view.zoom-out"],
      ["0", "view.zoom-fit"],
    ] as const) {
      expect(press(key, { ctrlKey: true, repeat: true }).defaultPrevented).toBe(true);
      expect(actions[id]).toHaveBeenCalledOnce();
    }
    expect(press("+", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(actions["view.zoom-in"]).toHaveBeenCalledTimes(2);
  });

  it("ignores composing/already-handled events and rejects text scopes before preventing default", () => {
    const { actions } = mounted();
    expect(press("o", { ctrlKey: true, isComposing: true }).defaultPrevented).toBe(false);
    const oldIME = new KeyboardEvent("keydown", {
      key: "o",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(oldIME, "keyCode", { value: 229 });
    act(() => window.dispatchEvent(oldIME));
    expect(oldIME.defaultPrevented).toBe(false);
    const handled = new KeyboardEvent("keydown", {
      key: "o",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    handled.preventDefault();
    act(() => window.dispatchEvent(handled));
    expect(actions["file.open"]).not.toHaveBeenCalled();
  });

  it("blocks native/open ARIA dialogs and menus but allows the own palette toggle", () => {
    const { actions, options, rerender, setContext } = mounted();
    const dialog = node("<dialog open><input /></dialog>");
    expect(press("o", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press("k", { ctrlKey: true }, dialog.firstElementChild ?? dialog).defaultPrevented).toBe(
      false,
    );
    rerender({ ...options, paletteOpen: true });
    expect(press("k", { ctrlKey: true }, dialog.firstElementChild ?? dialog).defaultPrevented).toBe(
      true,
    );
    expect(actions["commands.palette"]).toHaveBeenCalledOnce();
    setContext({ modalOpen: true });
    expect(press("k", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(actions["commands.palette"]).toHaveBeenCalledOnce();
    setContext({ modalOpen: false });
    dialog.parentElement?.remove();
    rerender(options);
    const aria = node("<div role='dialog' aria-modal='true'></div>");
    expect(press("s", { ctrlKey: true }).defaultPrevented).toBe(false);
    aria.parentElement?.remove();
    const menu = node("<div role='menu' data-open><button role='menuitem'>one</button></div>");
    expect(press("=", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press("Home", {}, menu.firstElementChild ?? menu).defaultPrevented).toBe(false);
    menu.parentElement?.remove();
    const menubar = node("<div role='menubar'><button aria-expanded='true'>File</button></div>");
    expect(press("o", { ctrlKey: true }).defaultPrevented).toBe(false);
    menubar.parentElement?.remove();
    expect(actions["file.open"]).not.toHaveBeenCalled();
    expect(actions["view.zoom-in"]).not.toHaveBeenCalled();
  });

  it("does not mistake a closed Base UI popup retained for exit animation for an active menu", () => {
    const { actions } = mounted();
    const menu = node(
      "<div role='menu' data-closed><button role='menuitem'>Zoom to Fit</button></div>",
    );
    const menubar = node("<div role='menubar'><button aria-expanded='false'>View</button></div>");
    expect(
      press("=", { ctrlKey: true }, menubar.firstElementChild ?? menubar).defaultPrevented,
    ).toBe(true);
    expect(press("-", { ctrlKey: true }, menu.firstElementChild ?? menu).defaultPrevented).toBe(
      true,
    );
    expect(actions["view.zoom-in"]).toHaveBeenCalledOnce();
    expect(actions["view.zoom-out"]).toHaveBeenCalledOnce();
  });

  it("handles synchronous exceptions and asynchronous rejections without losing shortcuts", async () => {
    const failure = new Error("failed");
    const onError = vi.fn();
    const { result } = mounted({
      onError,
      actions: {
        "file.open": () => {
          throw failure;
        },
        "file.save": () => Promise.reject(failure),
      },
    });
    expect(result.current.execute("file.open")).toBe(true);
    expect(onError).toHaveBeenCalledWith("file.open", failure);
    expect(result.current.execute("file.save")).toBe(true);
    await act(async () => {});
    expect(onError).toHaveBeenCalledWith("file.save", failure);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("keeps a single listener under StrictMode, removes it on unmount and uses fresh platform/actions", () => {
    const { actions, result, rerender, options, unmount } = mounted({}, true);
    expect(press("o", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(actions["file.open"]).toHaveBeenCalledOnce();
    const action = vi.fn();
    rerender({ ...options, platform: "mac", actions: { "file.open": action } });
    expect(press("o", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press("o", { metaKey: true }).defaultPrevented).toBe(true);
    expect(action).toHaveBeenCalledOnce();
    const execute = result.current.execute;
    unmount();
    expect(press("o", { metaKey: true }).defaultPrevented).toBe(false);
    expect(execute("file.open")).toBe(false);
    expect(action).toHaveBeenCalledOnce();
  });
});

it("reuses command metadata for fresh action closures, but updates enabled state and action availability", () => {
  const s = mounted();
  const commands = s.result.current.commands;
  const fresh = vi.fn();
  s.rerender({ ...s.options, actions: { ...s.actions, "file.open": fresh } });
  expect(s.result.current.commands).toBe(commands);
  s.result.current.execute("file.open");
  expect(fresh).toHaveBeenCalledOnce();
  s.setContext({ modalOpen: true });
  s.rerender(s.options);
  expect(s.result.current.commands).not.toBe(commands);
  expect(s.result.current.commands.find((command) => command.id === "edit.copy")?.enabled).toBe(
    false,
  );
  s.setContext({ modalOpen: false });
  s.rerender({ ...s.options, actions: {} });
  expect(s.result.current.commands.every((command) => !command.enabled)).toBe(true);
});
