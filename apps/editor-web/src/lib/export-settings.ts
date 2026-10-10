import type {
  DocumentExportParams,
  DocumentInfoResult,
  ExportDither,
  ExportNoiseShaping,
  ExportScope,
  SelectionRange,
} from "@aae/protocol";

export type LossyFormat = "opus" | "m4a";
export type ExportFormat = DocumentExportParams["format"] | LossyFormat;
export function isLossyFormat(format: ExportFormat | undefined): format is LossyFormat {
  return format === "opus" || format === "m4a";
}
export interface ExportSettings {
  format?: ExportFormat;
  bitrate?: number;
  encoding: "pcm" | "float";
  bitDepth: number;
  scope: ExportScope;
  dither: ExportDither;
  noiseShaping: ExportNoiseShaping;
  /**
   * Present while the dither follows the automatic rule for this source;
   * an explicit dither choice removes it.
   */
  autoDitherSource?: { bitDepth: number; float: boolean };
}

/** How the export dialog seeds its settings; Save and batch use none of it. */
export interface ExportDefaults {
  /** "source" keeps a FLAC/AIFF source's container, as Save does; otherwise WAV. */
  format?: "source" | DocumentExportParams["format"];
  /** "auto" applies TPDF when an integer export at ≤16 bits reduces resolution. */
  dither?: "auto" | ExportDither;
}

export const PCM_DEPTHS = [8, 16, 24, 32] as const;
export const FLOAT_DEPTHS = [32, 64] as const;

export function defaultExportSettings(
  info: DocumentInfoResult,
  defaults: ExportDefaults = {},
): ExportSettings {
  const format = info.format === "flac" || info.format === "aiff" ? info.format : "wav";
  const encoding = format === "wav" && info.float ? "float" : "pcm";
  const depths: readonly number[] =
    format === "flac" ? [8, 16, 24] : encoding === "float" ? FLOAT_DEPTHS : PCM_DEPTHS;
  const settings: ExportSettings = {
    format,
    encoding,
    bitDepth: depths.includes(info.bitDepth) ? info.bitDepth : encoding === "float" ? 32 : 24,
    scope: "document",
    dither: "none",
    noiseShaping: "none",
  };
  if (defaults.dither === "auto")
    settings.autoDitherSource = { bitDepth: info.bitDepth, float: info.float };
  else if (defaults.dither) settings.dither = defaults.dither;
  const preferred = defaults.format === "source" ? undefined : defaults.format;
  return updateExportSettings(settings, preferred ? { format: preferred } : {});
}

/** TPDF only where requantizing loses resolution: integer ≤16 bits below the source. */
function automaticDither(settings: ExportSettings): ExportDither {
  const source = settings.autoDitherSource;
  return source &&
    settings.encoding === "pcm" &&
    !isLossyFormat(settings.format) &&
    settings.bitDepth <= 16 &&
    (source.float || source.bitDepth > settings.bitDepth)
    ? "triangular"
    : "none";
}

export function updateExportSettings(
  previous: ExportSettings,
  change: Partial<ExportSettings>,
): ExportSettings {
  const settings = { ...previous, ...change };
  if (change.dither !== undefined) delete settings.autoDitherSource;
  if (isLossyFormat(settings.format)) {
    settings.bitrate ??= 128;
    settings.dither = "none";
    settings.noiseShaping = "none";
  }
  if (settings.format && settings.format !== "wav") settings.encoding = "pcm";
  const depths: readonly number[] = exportDepths(settings);
  if (!depths.includes(settings.bitDepth))
    settings.bitDepth = settings.encoding === "float" ? 32 : 24;
  if (settings.encoding === "float") {
    settings.dither = "none";
    settings.noiseShaping = "none";
  }
  if (settings.autoDitherSource) settings.dither = automaticDither(settings);
  return settings;
}

export function validExportSelection(selection: SelectionRange, info: DocumentInfoResult): boolean {
  return (
    Number.isSafeInteger(selection.start) &&
    Number.isSafeInteger(selection.end) &&
    selection.start >= 0 &&
    selection.end > selection.start &&
    selection.end <= info.frames &&
    Number.isInteger(selection.channelMask) &&
    selection.channelMask > 0 &&
    (selection.channelMask & (2 ** info.channels - 1)) === selection.channelMask
  );
}

export function exportParams(
  info: DocumentInfoResult,
  selection: SelectionRange,
  settings: ExportSettings,
): DocumentExportParams | undefined {
  if (isLossyFormat(settings.format)) return;
  const depths: readonly number[] = exportDepths(settings);
  if (
    !depths.includes(settings.bitDepth) ||
    (settings.scope === "selection" && !validExportSelection(selection, info))
  )
    return;
  return {
    documentId: info.documentId,
    format: settings.format ?? "wav",
    bitDepth: settings.bitDepth,
    float: settings.encoding === "float",
    scope: settings.scope,
    dither: settings.encoding === "float" ? "none" : settings.dither,
    noiseShaping: settings.encoding === "float" ? "none" : settings.noiseShaping,
  };
}

export function exportDepths(settings: ExportSettings): readonly number[] {
  return settings.format === "flac"
    ? [8, 16, 24]
    : settings.encoding === "float"
      ? FLOAT_DEPTHS
      : PCM_DEPTHS;
}
export function exportName(name: string, format: ExportFormat, selection = false): string {
  if (!selection && name.toLowerCase().endsWith(`.${format}`)) return name;
  return `${name.replace(/\.[^./]*$/, "") || "Untitled"}${selection ? "-selection" : ""}.${format}`;
}
export function exportFileTypes(format: ExportFormat) {
  const mime = {
    wav: "audio/wav",
    flac: "audio/flac",
    aiff: "audio/aiff",
    opus: "audio/ogg",
    m4a: "audio/mp4",
  }[format];
  return [{ description: `${format.toUpperCase()} audio`, accept: { [mime]: [`.${format}`] } }];
}
