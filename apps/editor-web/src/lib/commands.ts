import type { ClipboardInfo, DocumentInfoResult, SelectionRange } from "@aae/protocol";
import { effectMenuCategory, effectMenuEntries } from "@/lib/effect-menu";
import { stereoSelection } from "@/lib/effect-rack";
import { desktopBridge } from "@/platform";

export type CommandId =
  | "file.new"
  | "file.open"
  | "file.save"
  | "file.export"
  | "file.metadata"
  | "file.automation"
  | "file.batch"
  | "file.record-macro"
  | "file.stop-recording"
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
  | "process.crossfade"
  | "process.reverse"
  | "process.invert"
  | "process.remove-dc"
  | "process.mono-to-stereo"
  | "process.stereo-to-mono"
  | "process.extract-channel"
  | "process.resample"
  | "process.generate"
  | "process.generate-speech"
  | "process.capture-noise-profile"
  | "process.noise-reduce"
  | "process.spectral-attenuate"
  | "process.spectral-remove"
  | "process.spectral-heal"
  | "process.remove-clicks"
  | "process.declip"
  | "process.time-stretch"
  | "process.remove-hum"
  | "effects.rack"
  | "analyze.meters"
  | "analyze.spectrum"
  | "analyze.statistics"
  | "analyze.pitch"
  | "analyze.clipping"
  | "view.waveform"
  | "view.spectrogram"
  | "view.split-spectral"
  | `effects.${string}`;

export type ShortcutPlatform = "mac" | "other";

export interface CommandContext {
  recordingMacro?: boolean;
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
  noiseProfileReady?: boolean;
  hasSpectralSelection?: boolean;
  spectralHealAvailable?: boolean;
  effects?: readonly {
    id: string;
    name: string;
    category?: string;
    channelMode?: "mono" | "stereo";
  }[];
}

export type CommandActions = Partial<Record<CommandId, () => void | Promise<void>>>;

export interface ResolvedCommand {
  id: CommandId;
  label: string;
  menu: string;
  submenu?: string;
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
  submenu?: string;
  enabled(context: CommandContext): boolean;
  shortcuts?: readonly Shortcut[];
  globalInText?: boolean;
  allowRepeat?: boolean;
}

/** Editor actions, menu order and keyboard bindings share one typed source. */
export const COMMAND_MENUS: readonly { label: string; items: readonly (CommandId | "-")[] }[] = [
  {
    label: "File",
    items: [
      "file.new",
      "file.open",
      "-",
      "file.save",
      "file.export",
      "-",
      "file.metadata",
      "-",
      "file.automation",
      "file.batch",
      "file.record-macro",
      "file.stop-recording",
    ],
  },
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
  {
    label: "Process",
    items: [
      "process.amplify",
      "process.normalize",
      "process.fade",
      "process.crossfade",
      "-",
      "process.reverse",
      "process.invert",
      "process.remove-dc",
      "-",
      "process.mono-to-stereo",
      "process.stereo-to-mono",
      "process.extract-channel",
      "process.resample",
      "process.time-stretch",
      "-",
      "process.generate",
      "process.generate-speech",
    ],
  },
  {
    label: "Restore",
    items: [
      "process.capture-noise-profile",
      "process.noise-reduce",
      "-",
      "process.remove-clicks",
      "process.declip",
      "process.remove-hum",
      "-",
      "process.spectral-attenuate",
      "process.spectral-remove",
      "process.spectral-heal",
    ],
  },
  { label: "Effects", items: ["effects.rack"] },
  {
    label: "Analyze",
    items: [
      "analyze.meters",
      "analyze.spectrum",
      "-",
      "analyze.statistics",
      "analyze.pitch",
      "analyze.clipping",
    ],
  },
  {
    label: "View",
    items: [
      "view.zoom-in",
      "view.zoom-out",
      "view.zoom-fit",
      "view.zoom-selection",
      "-",
      "view.waveform",
      "view.spectrogram",
      "view.split-spectral",
    ],
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
const processAvailable = (c: CommandContext) => validSelection(c) && Boolean(c.info?.frames);
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
  { id: "file.automation", label: "Macros and automation…", menu: "File", enabled: available },
  {
    id: "file.batch",
    label: "Batch processing…",
    menu: "File",
    enabled: (c) => available(c) && !c.recordingMacro,
  },
  {
    id: "file.record-macro",
    label: "Record new macro",
    menu: "File",
    enabled: (c) => documentAvailable(c) && !c.recordingMacro,
  },
  {
    id: "file.stop-recording",
    label: "Stop recording macro",
    menu: "File",
    enabled: (c) => available(c) && Boolean(c.recordingMacro),
  },
  { id: "file.metadata", label: "File metadata…", menu: "File", enabled: documentAvailable },
  {
    id: "process.capture-noise-profile",
    label: "Capture noise profile",
    menu: "Restore",
    enabled: (c) =>
      rangeAvailable(c) && Boolean(c.selection && c.selection.end - c.selection.start >= 1024),
  },
  {
    id: "process.noise-reduce",
    label: "Noise reduction…",
    menu: "Restore",
    enabled: (c) => processAvailable(c) && Boolean(c.noiseProfileReady),
  },
  {
    id: "process.spectral-attenuate",
    label: "Attenuate spectral selection…",
    menu: "Restore",
    enabled: (c) => processAvailable(c) && Boolean(c.hasSpectralSelection),
  },
  {
    id: "process.spectral-remove",
    label: "Remove spectral selection…",
    menu: "Restore",
    enabled: (c) => processAvailable(c) && Boolean(c.hasSpectralSelection),
  },
  {
    id: "process.spectral-heal",
    label: "Heal spectral selection…",
    menu: "Restore",
    enabled: (c) =>
      processAvailable(c) && Boolean(c.hasSpectralSelection && c.spectralHealAvailable),
  },
  {
    id: "process.remove-clicks",
    label: "Remove clicks and pops…",
    menu: "Restore",
    enabled: processAvailable,
  },
  {
    id: "process.declip",
    label: "Repair clipped audio…",
    menu: "Restore",
    enabled: processAvailable,
  },
  {
    id: "process.remove-hum",
    label: "Remove mains hum…",
    menu: "Restore",
    enabled: processAvailable,
  },
  {
    id: "process.time-stretch",
    label: "Time stretch…",
    menu: "Process",
    enabled: (c) =>
      processAvailable(c) && c.selection?.channelMask === 2 ** (c.info?.channels ?? 0) - 1,
  },
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
    label: "Export audio…",
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
  {
    id: "process.amplify",
    label: "Amplify…",
    menu: "Process",
    enabled: (c) => validSelection(c) && Boolean(c.info?.frames),
  },
  {
    id: "process.normalize",
    label: "Normalize…",
    menu: "Process",
    enabled: (c) => validSelection(c) && Boolean(c.info?.frames),
  },
  { id: "process.fade", label: "Fade In / Out…", menu: "Process", enabled: processAvailable },
  {
    id: "process.crossfade",
    label: "Crossfade at cursor…",
    menu: "Process",
    enabled: (c) =>
      processAvailable(c) &&
      Boolean(
        c.selection &&
          c.selection.start === c.selection.end &&
          c.selection.start > 0 &&
          c.selection.end < (c.info?.frames ?? 0),
      ),
  },
  { id: "process.reverse", label: "Reverse…", menu: "Process", enabled: processAvailable },
  { id: "process.invert", label: "Invert polarity…", menu: "Process", enabled: processAvailable },
  {
    id: "process.remove-dc",
    label: "Remove DC offset…",
    menu: "Process",
    enabled: processAvailable,
  },
  {
    id: "process.mono-to-stereo",
    label: "Mono to stereo…",
    menu: "Process",
    enabled: (c) => processAvailable(c) && c.info?.channels === 1,
  },
  {
    id: "process.stereo-to-mono",
    label: "Stereo to mono…",
    menu: "Process",
    enabled: (c) => processAvailable(c) && c.info?.channels === 2,
  },
  {
    id: "process.extract-channel",
    label: "Extract channel…",
    menu: "Process",
    enabled: processAvailable,
  },
  {
    id: "process.resample",
    label: "Change sample rate…",
    menu: "Process",
    enabled: processAvailable,
  },
  { id: "process.generate", label: "Generate audio…", menu: "Process", enabled: validSelection },
  {
    id: "process.generate-speech",
    label: "Generate speech…",
    menu: "Process",
    enabled: validSelection,
  },
  { id: "effects.rack", label: "Effect rack…", menu: "Effects", enabled: processAvailable },
  { id: "analyze.meters", label: "Playback meters", menu: "Analyze", enabled: processAvailable },
  {
    id: "analyze.spectrum",
    label: "Spectrum analyzer",
    menu: "Analyze",
    enabled: processAvailable,
  },
  {
    id: "analyze.statistics",
    label: "Audio statistics…",
    menu: "Analyze",
    enabled: processAvailable,
  },
  { id: "analyze.pitch", label: "Pitch tracking…", menu: "Analyze", enabled: processAvailable },
  { id: "analyze.clipping", label: "Detect clipping…", menu: "Analyze", enabled: processAvailable },
  { id: "view.waveform", label: "Waveform lanes", menu: "View", enabled: documentAvailable },
  { id: "view.spectrogram", label: "Spectrogram lanes", menu: "View", enabled: processAvailable },
  {
    id: "view.split-spectral",
    label: "Waveform and spectrogram",
    menu: "View",
    enabled: processAvailable,
  },
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
  const catalogue: Definition[] = effectMenuEntries(context.effects ?? []).map((effect) => ({
    id: `effects.${effect.id}`,
    label: `${effect.name}…`,
    menu: "Effects",
    submenu: effectMenuCategory(effect),
    enabled: (current) =>
      processAvailable(current) &&
      (effect.channelMode !== "stereo" || stereoSelection(current.selection?.channelMask ?? 0)),
  }));
  return [...definitions, ...catalogue].map((definition) => ({
    id: definition.id,
    label: definition.label,
    menu: definition.menu,
    ...(definition.submenu ? { submenu: definition.submenu } : {}),
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
