import type { ClipboardInfo, DocumentInfoResult, SelectionRange } from "@aae/protocol";
import { desktopBridge } from "@/platform";

export type CommandId =
  | "file.new"
  | "file.open"
  | "file.save"
  | "file.export"
  | "edit.undo"
  | "edit.redo"
  | "edit.cut"
  | "edit.copy"
  | "edit.paste-insert"
  | "edit.paste-replace"
  | "edit.paste-mix"
  | "edit.delete"
  | "edit.crop"
  | "edit.duplicate"
  | "edit.swap-channels"
  | "edit.mute"
  | "edit.insert-silence"
  | "edit.select-all"
  | "timeline.add-marker"
  | "timeline.add-region"
  | "timeline.export-csv"
  | "timeline.export-labels"
  | "view.zoom-in"
  | "view.zoom-out"
  | "view.zoom-fit"
  | "view.zoom-selection"
  | "transport.toggle-playback"
  | "transport.stop"
  | "transport.seek-start"
  | "transport.seek-end"
  | "commands.palette"
  | "help.about"
  | "process.amplify"
  | "process.normalize"
  | "process.fade"
  | "effects.equalizer"
  | "effects.dynamics"
  | "effects.reverb";

export type ShortcutPlatform = "mac" | "other";

export interface CommandContext {
  ready: boolean;
  busy: boolean;
  audioReady: boolean;
  info?: DocumentInfoResult;
  selection?: SelectionRange;
  clipboard?: ClipboardInfo;
  canUndo: boolean;
  canRedo: boolean;
  playing: boolean;
  silenceFrames?: number;
  modalOpen?: boolean;
}

export type CommandActions = Partial<Record<CommandId, () => void | Promise<void>>>;

export interface ResolvedCommand {
  id: CommandId;
  label: string;
  menu: string;
  shortcutLabel?: string;
  ariaShortcut?: string;
  enabled: boolean;
}

interface Shortcut {
  key: string;
  mod?: boolean;
  shift?: boolean;
  otherOnly?: boolean;
}

interface Definition {
  id: CommandId;
  label: string;
  menu: string;
  enabled(context: CommandContext): boolean;
  shortcuts?: readonly Shortcut[];
  globalInText?: boolean;
  allowRepeat?: boolean;
}

/** Editor actions, menu order and keyboard bindings share one typed source. */
export const COMMAND_MENUS: readonly { label: string; items: readonly (CommandId | "-")[] }[] = [
  { label: "File", items: ["file.new", "file.open", "-", "file.save", "file.export"] },
  {
    label: "Edit",
    items: [
      "edit.undo",
      "edit.redo",
      "-",
      "edit.cut",
      "edit.copy",
      "edit.paste-insert",
      "edit.paste-replace",
      "edit.paste-mix",
      "-",
      "edit.delete",
      "edit.crop",
      "edit.duplicate",
      "edit.swap-channels",
      "edit.mute",
      "edit.insert-silence",
      "-",
      "edit.select-all",
    ],
  },
  { label: "Process", items: ["process.amplify", "process.normalize", "process.fade"] },
  { label: "Effects", items: ["effects.equalizer", "effects.dynamics", "effects.reverb"] },
  {
    label: "View",
    items: ["view.zoom-in", "view.zoom-out", "view.zoom-fit", "view.zoom-selection"],
  },
  {
    label: "Transport",
    items: [
      "transport.toggle-playback",
      "transport.stop",
      "-",
      "transport.seek-start",
      "transport.seek-end",
    ],
  },
  {
    label: "Markers",
    items: [
      "timeline.add-marker",
      "timeline.add-region",
      "-",
      "timeline.export-csv",
      "timeline.export-labels",
    ],
  },
  { label: "Help", items: ["commands.palette", "help.about"] },
];

const available = (c: CommandContext) => c.ready && !c.busy && !c.modalOpen;
const documentAvailable = (c: CommandContext) => available(c) && validDocument(c.info);

function validDocument(info: DocumentInfoResult | undefined): info is DocumentInfoResult {
  return Boolean(
    info?.documentId &&
      Number.isSafeInteger(info.frames) &&
      info.frames >= 0 &&
      Number.isInteger(info.channels) &&
      info.channels >= 1 &&
      info.channels <= 8 &&
      Number.isInteger(info.sampleRate) &&
      info.sampleRate >= 8000 &&
      info.sampleRate <= 384000,
  );
}

function validSelection(c: CommandContext): boolean {
  const s = c.selection;
  return Boolean(
    documentAvailable(c) &&
      s &&
      Number.isSafeInteger(s.start) &&
      Number.isSafeInteger(s.end) &&
      s.start >= 0 &&
      s.end >= s.start &&
      s.end <= (c.info?.frames ?? 0) &&
      Number.isInteger(s.channelMask) &&
      s.channelMask > 0 &&
      s.channelMask <= 255 &&
      (s.channelMask & (2 ** (c.info?.channels ?? 0) - 1)) === s.channelMask,
  );
}

const rangeAvailable = (c: CommandContext) =>
  validSelection(c) && Boolean(c.selection && c.selection.end > c.selection.start);
function twoChannels(c: CommandContext): boolean {
  if (!validSelection(c) || !c.selection) return false;
  const remaining = c.selection.channelMask & (c.selection.channelMask - 1);
  return remaining !== 0 && (remaining & (remaining - 1)) === 0;
}

function safeGrowth(c: CommandContext, inserted: number, removed = 0): boolean {
  return Boolean(
    c.info &&
      Number.isSafeInteger(inserted) &&
      inserted >= 0 &&
      inserted <= Number.MAX_SAFE_INTEGER - (c.info.frames - removed),
  );
}

function pasteAvailable(c: CommandContext, mode: "insert" | "replace" | "mix"): boolean {
  const clip = c.clipboard;
  if (
    !validSelection(c) ||
    !clip?.available ||
    !clip.version ||
    !Number.isSafeInteger(clip.frames) ||
    clip.frames <= 0 ||
    !Number.isInteger(clip.channels) ||
    clip.channels < 1 ||
    clip.channels > 8 ||
    !Number.isInteger(clip.sampleRate) ||
    clip.sampleRate < 8000 ||
    clip.sampleRate > 384000 ||
    !c.info ||
    !c.selection
  )
    return false;
  // This is metadata-only capacity arithmetic, not sample processing. The
  // kernel remains authoritative for conversion, memory budgets and mixing.
  const numerator = BigInt(clip.frames) * BigInt(c.info.sampleRate);
  const count = (numerator + BigInt(clip.sampleRate) - 1n) / BigInt(clip.sampleRate);
  if (count > BigInt(Number.MAX_SAFE_INTEGER)) return false;
  const frames = Number(count);
  if (mode === "mix") return frames <= Number.MAX_SAFE_INTEGER - c.selection.start;
  return safeGrowth(c, frames, mode === "replace" ? c.selection.end - c.selection.start : 0);
}

const mod = (key: string, shift = false): Shortcut => ({ key, mod: true, shift });
const definitions: readonly Definition[] = [
  { id: "file.new", label: "New…", menu: "File", enabled: () => false },
  {
    id: "file.open",
    label: "Open…",
    menu: "File",
    enabled: available,
    shortcuts: [mod("o")],
    globalInText: true,
  },
  {
    id: "file.save",
    label: "Save",
    menu: "File",
    enabled: documentAvailable,
    shortcuts: [mod("s")],
    globalInText: true,
  },
  {
    id: "file.export",
    label: "Export WAV…",
    menu: "File",
    enabled: documentAvailable,
    shortcuts: [mod("e", true)],
    globalInText: true,
  },
  {
    id: "edit.undo",
    label: "Undo",
    menu: "Edit",
    enabled: (c) => documentAvailable(c) && c.canUndo,
    shortcuts: [mod("z")],
  },
  {
    id: "edit.redo",
    label: "Redo",
    menu: "Edit",
    enabled: (c) => documentAvailable(c) && c.canRedo,
    shortcuts: [mod("z", true), { ...mod("y"), otherOnly: true }],
  },
  { id: "edit.cut", label: "Cut", menu: "Edit", enabled: rangeAvailable, shortcuts: [mod("x")] },
  { id: "edit.copy", label: "Copy", menu: "Edit", enabled: rangeAvailable, shortcuts: [mod("c")] },
  {
    id: "edit.paste-insert",
    label: "Paste",
    menu: "Edit",
    enabled: (c) => pasteAvailable(c, "insert"),
    shortcuts: [mod("v")],
  },
  {
    id: "edit.paste-replace",
    label: "Replace with clipboard",
    menu: "Edit",
    enabled: (c) => pasteAvailable(c, "replace"),
  },
  {
    id: "edit.paste-mix",
    label: "Mix clipboard",
    menu: "Edit",
    enabled: (c) => pasteAvailable(c, "mix"),
  },
  {
    id: "edit.delete",
    label: "Delete selection",
    menu: "Edit",
    enabled: rangeAvailable,
    shortcuts: [{ key: "Delete" }],
  },
  { id: "edit.crop", label: "Crop time (all channels)", menu: "Edit", enabled: rangeAvailable },
  {
    id: "edit.duplicate",
    label: "Duplicate",
    menu: "Edit",
    enabled: (c) =>
      rangeAvailable(c) && safeGrowth(c, (c.selection?.end ?? 0) - (c.selection?.start ?? 0)),
  },
  { id: "edit.swap-channels", label: "Swap selected channels", menu: "Edit", enabled: twoChannels },
  { id: "edit.mute", label: "Mute", menu: "Edit", enabled: rangeAvailable },
  {
    id: "edit.insert-silence",
    label: "Insert silence",
    menu: "Edit",
    enabled: (c) =>
      validSelection(c) &&
      Boolean(c.silenceFrames && c.silenceFrames > 0) &&
      safeGrowth(c, c.silenceFrames ?? 0),
  },
  {
    id: "edit.select-all",
    label: "Select all",
    menu: "Edit",
    enabled: documentAvailable,
    shortcuts: [mod("a")],
  },
  { id: "process.amplify", label: "Amplify…", menu: "Process", enabled: () => false },
  { id: "process.normalize", label: "Normalize…", menu: "Process", enabled: () => false },
  { id: "process.fade", label: "Fade In / Out", menu: "Process", enabled: () => false },
  { id: "effects.equalizer", label: "Equalizer…", menu: "Effects", enabled: () => false },
  { id: "effects.dynamics", label: "Dynamics…", menu: "Effects", enabled: () => false },
  { id: "effects.reverb", label: "Reverb…", menu: "Effects", enabled: () => false },
  {
    id: "view.zoom-in",
    label: "Zoom In",
    menu: "View",
    enabled: documentAvailable,
    shortcuts: [mod("="), mod("+", true), mod("=", true), mod("+")],
    allowRepeat: true,
  },
  {
    id: "view.zoom-out",
    label: "Zoom Out",
    menu: "View",
    enabled: documentAvailable,
    shortcuts: [mod("-")],
    allowRepeat: true,
  },
  {
    id: "view.zoom-fit",
    label: "Zoom to Fit",
    menu: "View",
    enabled: documentAvailable,
    shortcuts: [mod("0")],
    allowRepeat: true,
  },
  { id: "view.zoom-selection", label: "Zoom to Selection", menu: "View", enabled: rangeAvailable },
  {
    id: "transport.toggle-playback",
    label: "Play / Stop",
    menu: "Transport",
    enabled: (c) => documentAvailable(c) && c.audioReady && Boolean(c.info && c.info.frames > 0),
    shortcuts: [{ key: " " }],
  },
  {
    id: "transport.stop",
    label: "Stop",
    menu: "Transport",
    enabled: (c) => available(c) && c.audioReady && c.playing,
  },
  {
    id: "transport.seek-start",
    label: "Go to Start",
    menu: "Transport",
    enabled: (c) => documentAvailable(c) && c.audioReady,
    shortcuts: [{ key: "Home" }],
  },
  {
    id: "transport.seek-end",
    label: "Go to End",
    menu: "Transport",
    enabled: (c) => documentAvailable(c) && c.audioReady,
    shortcuts: [{ key: "End" }],
  },
  { id: "timeline.add-marker", label: "Add marker", menu: "Markers", enabled: validSelection },
  { id: "timeline.add-region", label: "Add region", menu: "Markers", enabled: rangeAvailable },
  {
    id: "timeline.export-csv",
    label: "Export markers CSV…",
    menu: "Markers",
    enabled: documentAvailable,
  },
  {
    id: "timeline.export-labels",
    label: "Export labels…",
    menu: "Markers",
    enabled: documentAvailable,
  },
  {
    id: "commands.palette",
    label: "Command palette…",
    menu: "Help",
    enabled: (c) => !c.modalOpen,
    shortcuts: [mod("k")],
    globalInText: true,
  },
  { id: "help.about", label: "About", menu: "Help", enabled: (c) => !c.modalOpen },
];

export function detectShortcutPlatform(): ShortcutPlatform {
  const desktop = desktopBridge();
  if (desktop) return desktop.platform === "darwin" ? "mac" : "other";
  return typeof navigator !== "undefined" && /Mac/i.test(navigator.platform) ? "mac" : "other";
}

function shortcutLabels(shortcut: Shortcut, platform: ShortcutPlatform) {
  const key =
    shortcut.key === " "
      ? "Space"
      : shortcut.key.length === 1
        ? shortcut.key.toUpperCase()
        : shortcut.key;
  const modifiers = shortcut.mod ? [platform === "mac" ? "Cmd" : "Ctrl"] : [];
  if (shortcut.shift) modifiers.push("Shift");
  return {
    shortcutLabel: [...modifiers, key].join("+"),
    ariaShortcut: [
      ...(shortcut.mod ? [platform === "mac" ? "Meta" : "Control"] : []),
      ...(shortcut.shift ? ["Shift"] : []),
      key,
    ].join("+"),
  };
}

export function resolveCommands(
  context: CommandContext,
  platform: ShortcutPlatform,
  actions: CommandActions,
): ResolvedCommand[] {
  return definitions.map((definition) => ({
    id: definition.id,
    label: definition.label,
    menu: definition.menu,
    ...(definition.shortcuts?.[0] ? shortcutLabels(definition.shortcuts[0], platform) : {}),
    enabled: Boolean(actions[definition.id] && definition.enabled(context)),
  }));
}

export interface CommandShortcutMatch {
  id: CommandId;
  globalInText: boolean;
  allowRepeat: boolean;
}

/** Pure matching uses exact modifiers; the hook owns DOM focus/scope checks. */
export function matchCommandShortcut(
  event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">,
  platform: ShortcutPlatform,
): CommandShortcutMatch | undefined {
  if (event.altKey) return;
  const key =
    event.code === "Space" ? " " : event.key.length === 1 ? event.key.toLowerCase() : event.key;
  for (const definition of definitions) {
    for (const shortcut of definition.shortcuts ?? []) {
      if (shortcut.otherOnly && platform === "mac") continue;
      const ctrl = Boolean(shortcut.mod && platform === "other");
      const meta = Boolean(shortcut.mod && platform === "mac");
      if (
        event.ctrlKey === ctrl &&
        event.metaKey === meta &&
        event.shiftKey === Boolean(shortcut.shift) &&
        key === shortcut.key
      )
        return {
          id: definition.id,
          globalInText: Boolean(definition.globalInText),
          allowRepeat: Boolean(definition.allowRepeat),
        };
    }
  }
}
