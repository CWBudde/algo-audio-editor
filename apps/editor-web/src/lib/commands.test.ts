import type { ClipboardInfo, DocumentInfoResult } from "@aae/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMMAND_MENUS,
  type CommandActions,
  type CommandContext,
  type CommandId,
  detectShortcutPlatform,
  matchCommandShortcut,
  resolveCommands,
} from "./commands";

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
const context: CommandContext = {
  ready: true,
  busy: false,
  audioReady: true,
  info,
  selection: { start: 10, end: 20, channelMask: 3 },
  clipboard,
  canUndo: true,
  canRedo: true,
  playing: true,
  silenceFrames: 10,
};
const allIds = COMMAND_MENUS.flatMap((menu) =>
  menu.items.filter((id): id is CommandId => id !== "-"),
);
const actions: CommandActions = Object.fromEntries(allIds.map((id) => [id, () => {}]));
function enabled(id: CommandId, overrides: Partial<CommandContext> = {}) {
  return resolveCommands({ ...context, ...overrides }, "other", actions).find(
    (command) => command.id === id,
  )?.enabled;
}
function key(
  key: string,
  modifiers: Partial<
    Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "code">
  > = {},
) {
  return {
    key,
    code: "",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...modifiers,
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete window.aaeDesktop;
});

describe("central command registry", () => {
  it("exposes Amplify and Normalize for valid nonempty document selections and cursors", () => {
    for (const id of ["process.amplify", "process.normalize"] as const) {
      expect(enabled(id)).toBe(true);
      expect(enabled(id, { selection: { start: 0, end: 0, channelMask: 2 } })).toBe(true);
      expect(enabled(id, { busy: true })).toBe(false);
      expect(enabled(id, { ready: false })).toBe(false);
      expect(enabled(id, { info: undefined })).toBe(false);
    }
  });
  it("owns unique IDs, menu order and metadata for every command", () => {
    const resolved = resolveCommands(context, "other", actions);
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(new Set(resolved.map((command) => command.id))).toEqual(new Set(allIds));
    expect(COMMAND_MENUS.map((menu) => menu.label)).toEqual([
      "File",
      "Edit",
      "Process",
      "Effects",
      "Analyze",
      "View",
      "Transport",
      "Markers",
      "Help",
    ]);
    for (const menu of COMMAND_MENUS)
      for (const id of menu.items) {
        if (id !== "-")
          expect(resolved.find((command) => command.id === id)).toMatchObject({
            menu: menu.label,
            label: expect.any(String),
          });
      }
    expect(resolved.find((command) => command.id === "file.export")).toMatchObject({
      label: "Export WAV…",
      shortcutLabel: "Ctrl+Shift+E",
      ariaShortcut: "Control+Shift+E",
    });
    expect(
      resolveCommands(context, "mac", actions).find((command) => command.id === "file.export"),
    ).toMatchObject({ shortcutLabel: "Cmd+Shift+E", ariaShortcut: "Meta+Shift+E" });
  });

  it("disables missing actions and planned commands without exposing fake shortcuts", () => {
    expect(resolveCommands(context, "other", {}).every((command) => !command.enabled)).toBe(true);
    for (const id of ["file.new"] as const) {
      expect(enabled(id)).toBe(false);
      expect(
        resolveCommands(context, "other", actions).find((command) => command.id === id)
          ?.shortcutLabel,
      ).toBeUndefined();
    }
    expect(matchCommandShortcut(key("n", { ctrlKey: true }), "other")).toBeUndefined();
  });

  it("gates cursor crossfade and channel conversion while permitting generators in empty documents", () => {
    expect(enabled("process.fade")).toBe(true);
    expect(enabled("process.crossfade")).toBe(false);
    expect(
      enabled("process.crossfade", { selection: { start: 50, end: 50, channelMask: 2 } }),
    ).toBe(true);
    expect(enabled("process.crossfade", { selection: { start: 0, end: 0, channelMask: 3 } })).toBe(
      false,
    );
    expect(enabled("process.mono-to-stereo")).toBe(false);
    expect(
      enabled("process.mono-to-stereo", {
        info: { ...info, channels: 1 },
        selection: { start: 0, end: 0, channelMask: 1 },
      }),
    ).toBe(true);
    expect(enabled("process.stereo-to-mono")).toBe(true);
    expect(enabled("process.stereo-to-mono", { info: { ...info, channels: 3 } })).toBe(false);
    expect(
      enabled("process.generate", {
        info: { ...info, frames: 0 },
        selection: { start: 0, end: 0, channelMask: 3 },
      }),
    ).toBe(true);
    expect(enabled("process.generate", { info: undefined })).toBe(false);
    for (const id of [
      "process.reverse",
      "process.invert",
      "process.remove-dc",
      "process.resample",
      "process.extract-channel",
    ] as const) {
      expect(enabled(id)).toBe(true);
      expect(enabled(id, { busy: true })).toBe(false);
      expect(
        enabled(id, {
          info: { ...info, frames: 0 },
          selection: { start: 0, end: 0, channelMask: 3 },
        }),
      ).toBe(false);
    }
  });

  it("supports palette/about before boot and palette during busy while preserving edit gates", () => {
    expect(enabled("commands.palette", { ready: false, busy: true, info: undefined })).toBe(true);
    expect(enabled("help.about", { ready: false, busy: true })).toBe(true);
    for (const id of [
      "file.open",
      "file.save",
      "edit.copy",
      "view.zoom-fit",
      "transport.stop",
    ] as const)
      expect(enabled(id, { busy: true })).toBe(false);
    expect(enabled("commands.palette", { modalOpen: true })).toBe(false);
    expect(enabled("help.about", { modalOpen: true })).toBe(false);
    expect(enabled("file.open", { info: undefined })).toBe(true);
    expect(enabled("file.save", { info: undefined })).toBe(false);
    expect(enabled("edit.undo", { canUndo: false })).toBe(false);
    expect(enabled("edit.redo", { canRedo: false })).toBe(false);
  });

  it("accepts empty-document cursor actions but rejects empty-range edits/playback", () => {
    const empty = { info: { ...info, frames: 0 }, selection: { start: 0, end: 0, channelMask: 3 } };
    for (const id of [
      "file.save",
      "file.export",
      "edit.paste-insert",
      "edit.paste-replace",
      "edit.paste-mix",
      "edit.swap-channels",
      "edit.insert-silence",
      "edit.select-all",
      "timeline.add-marker",
      "timeline.export-csv",
      "transport.seek-end",
    ] as const)
      expect(enabled(id, empty), id).toBe(true);
    for (const id of [
      "edit.copy",
      "edit.cut",
      "edit.delete",
      "edit.crop",
      "edit.mute",
      "edit.duplicate",
      "timeline.add-region",
      "view.zoom-selection",
      "transport.toggle-playback",
      "process.amplify",
      "process.normalize",
    ] as const)
      expect(enabled(id, empty), id).toBe(false);
    expect(enabled("transport.stop", { playing: false })).toBe(false);
    expect(enabled("transport.toggle-playback", { audioReady: false })).toBe(false);
  });

  it.each([
    { start: -1, end: 20, channelMask: 3 },
    { start: 20, end: 10, channelMask: 3 },
    { start: 0.5, end: 20, channelMask: 3 },
    { start: 10, end: 101, channelMask: 3 },
    { start: 10, end: Number.POSITIVE_INFINITY, channelMask: 3 },
    { start: 10, end: 20, channelMask: 0 },
    { start: 10, end: 20, channelMask: 4 },
    { start: 10, end: 20, channelMask: 3.5 },
    { start: 10, end: 20, channelMask: 2 ** 32 + 3 },
  ])("rejects malformed selection %j", (selection) => {
    for (const id of [
      "edit.copy",
      "edit.swap-channels",
      "edit.paste-insert",
      "edit.insert-silence",
      "timeline.add-marker",
      "process.amplify",
      "process.normalize",
    ] as const)
      expect(enabled(id, { selection }), id).toBe(false);
  });

  it("validates all channel subsets including bit 7 and exactly-two swapping", () => {
    for (let channel = 0; channel < 8; channel++)
      expect(
        enabled("timeline.add-marker", {
          info: { ...info, channels: 8 },
          selection: { start: 1, end: 1, channelMask: 1 << channel },
        }),
      ).toBe(true);
    for (const [mask, want] of [
      [1, false],
      [3, true],
      [0x81, true],
      [7, false],
      [255, false],
    ] as const)
      expect(
        enabled("edit.swap-channels", {
          info: { ...info, channels: 8 },
          selection: { start: 0, end: 0, channelMask: mask },
        }),
      ).toBe(want);
    for (const invalid of [
      { ...info, channels: 9 },
      { ...info, frames: Number.MAX_SAFE_INTEGER + 1 },
      { ...info, sampleRate: 7999 },
    ])
      expect(enabled("file.export", { info: invalid })).toBe(false);
  });

  it("checks safe capacity without losing long frame precision or performing sample work", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const long = {
      info: { ...info, frames: max },
      selection: { start: max - 1, end: max, channelMask: 3 },
      clipboard: { ...clipboard, frames: 1 },
      silenceFrames: 1,
    };
    expect(enabled("edit.duplicate", long)).toBe(false);
    expect(enabled("edit.insert-silence", long)).toBe(false);
    expect(enabled("edit.paste-insert", long)).toBe(false);
    expect(enabled("edit.paste-replace", long)).toBe(true);
    expect(enabled("edit.paste-mix", long)).toBe(true);
    expect(enabled("edit.paste-mix", { ...long, clipboard: { ...clipboard, frames: 2 } })).toBe(
      false,
    );
    expect(
      enabled("edit.paste-insert", {
        ...long,
        info: { ...info, frames: max - 1 },
        selection: { start: 0, end: 0, channelMask: 1 },
        clipboard: { ...clipboard, sampleRate: 24000, frames: 1 },
      }),
    ).toBe(false);
    expect(
      enabled("edit.paste-insert", {
        ...long,
        info: { ...info, frames: max - 2 },
        selection: { start: 0, end: 0, channelMask: 1 },
        clipboard: { ...clipboard, sampleRate: 24000, frames: 1 },
      }),
    ).toBe(true);
    for (const frames of [0, -1, 0.5, NaN, Infinity])
      expect(enabled("edit.insert-silence", { silenceFrames: frames })).toBe(false);
    for (const bad of [
      { ...clipboard, available: false },
      { ...clipboard, frames: 0 },
      { ...clipboard, frames: Infinity },
      { ...clipboard, sampleRate: 0 },
      { ...clipboard, channels: 9 },
    ])
      expect(enabled("edit.paste-insert", { clipboard: bad })).toBe(false);
  });

  it("detects Electron platform first, then browser Mac platforms", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    expect(detectShortcutPlatform()).toBe("mac");
    window.aaeDesktop = { platform: "linux", versions: { electron: "", chrome: "", node: "" } };
    expect(detectShortcutPlatform()).toBe("other");
    window.aaeDesktop.platform = "darwin";
    expect(detectShortcutPlatform()).toBe("mac");
    delete window.aaeDesktop;
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    expect(detectShortcutPlatform()).toBe("other");
    vi.stubGlobal("navigator", undefined);
    expect(detectShortcutPlatform()).toBe("other");
  });
});

describe("pure shortcut matching", () => {
  it.each(["other", "mac"] as const)(
    "matches only the platform primary modifier on %s",
    (platform) => {
      const primary = platform === "mac" ? { metaKey: true } : { ctrlKey: true };
      expect(matchCommandShortcut(key("o", primary), platform)?.id).toBe("file.open");
      expect(matchCommandShortcut(key("O", primary), platform)?.id).toBe("file.open");
      expect(
        matchCommandShortcut(key("o", { ...primary, altKey: true }), platform),
      ).toBeUndefined();
      expect(
        matchCommandShortcut(key("o", { ...primary, shiftKey: true }), platform),
      ).toBeUndefined();
      expect(
        matchCommandShortcut(key("o", { ctrlKey: true, metaKey: true }), platform),
      ).toBeUndefined();
      expect(
        matchCommandShortcut(
          key("o", platform === "mac" ? { ctrlKey: true } : { metaKey: true }),
          platform,
        ),
      ).toBeUndefined();
      expect(matchCommandShortcut(key("z", primary), platform)?.id).toBe("edit.undo");
      expect(matchCommandShortcut(key("z", { ...primary, shiftKey: true }), platform)?.id).toBe(
        "edit.redo",
      );
      expect(matchCommandShortcut(key("y", primary), platform)?.id).toBe(
        platform === "mac" ? undefined : "edit.redo",
      );
    },
  );

  it("supports shifted plus zoom only and preserves exact modifiers elsewhere", () => {
    for (const event of [
      key("=", { ctrlKey: true }),
      key("+", { ctrlKey: true, shiftKey: true }),
      key("=", { ctrlKey: true, shiftKey: true }),
    ])
      expect(matchCommandShortcut(event, "other")).toMatchObject({
        id: "view.zoom-in",
        allowRepeat: true,
      });
    expect(
      matchCommandShortcut(key("-", { ctrlKey: true, shiftKey: true }), "other"),
    ).toBeUndefined();
    expect(
      matchCommandShortcut(key("0", { ctrlKey: true, shiftKey: true }), "other"),
    ).toBeUndefined();
    expect(
      matchCommandShortcut(key("v", { ctrlKey: true, shiftKey: true }), "other"),
    ).toBeUndefined();
    expect(matchCommandShortcut(key(" ", {}), "other")).toMatchObject({
      id: "transport.toggle-playback",
      allowRepeat: false,
    });
    expect(matchCommandShortcut(key("", { code: "Space" }), "other")?.id).toBe(
      "transport.toggle-playback",
    );
    expect(matchCommandShortcut(key("Home", { ctrlKey: true }), "other")).toBeUndefined();
    expect(matchCommandShortcut(key("Delete"), "other")?.id).toBe("edit.delete");
  });
});

it("registers catalogue menu commands and fences stereo effects on incomplete selected pairs", () => {
  const id: CommandId = "effects.spatial-pan";
  const effects = [
    { id: "spatial-pan", name: "Panner", category: "Spatial", channelMode: "stereo" as const },
  ];
  const dynamic = { ...actions, [id]: vi.fn() };
  expect(
    resolveCommands({ ...context, effects }, "other", dynamic).find((command) => command.id === id),
  ).toMatchObject({ label: "Panner…", enabled: true, menu: "Effects", submenu: "Spatial" });
  expect(
    resolveCommands(
      { ...context, effects, selection: { start: 0, end: 0, channelMask: 2 } },
      "other",
      dynamic,
    ).find((command) => command.id === id)?.enabled,
  ).toBe(false);
  expect(
    resolveCommands({ ...context, effects, modalOpen: true }, "other", dynamic).find(
      (command) => command.id === id,
    )?.enabled,
  ).toBe(false);
});

it("keeps analysis discoverable while requiring a nonempty document, valid channels and no modal", () => {
  for (const id of [
    "analyze.meters",
    "analyze.spectrum",
    "analyze.statistics",
    "analyze.pitch",
    "analyze.clipping",
    "view.spectrogram",
    "view.split-spectral",
  ] as const) {
    expect(enabled(id)).toBe(true);
    expect(enabled(id, { selection: { start: 0, end: 0, channelMask: 2 } })).toBe(true);
    for (const blocked of [
      { busy: true },
      { modalOpen: true },
      { ready: false },
      { info: undefined },
      { info: { ...info, frames: 0 }, selection: { start: 0, end: 0, channelMask: 3 } },
      { selection: { start: 0, end: 0, channelMask: 4 } },
    ])
      expect(enabled(id, blocked)).toBe(false);
  }
});
