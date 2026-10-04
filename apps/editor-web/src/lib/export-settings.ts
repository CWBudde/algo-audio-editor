import type {
  DocumentExportParams,
  DocumentInfoResult,
  ExportDither,
  ExportNoiseShaping,
  ExportScope,
  SelectionRange,
} from "@aae/protocol";

export interface ExportSettings {
  format?: DocumentExportParams["format"];
  encoding: "pcm" | "float";
  bitDepth: number;
  scope: ExportScope;
  dither: ExportDither;
  noiseShaping: ExportNoiseShaping;
}

export const PCM_DEPTHS = [8, 16, 24, 32] as const;
export const FLOAT_DEPTHS = [32, 64] as const;

export function defaultExportSettings(info: DocumentInfoResult): ExportSettings {
  const format = info.format === "flac" || info.format === "aiff" ? info.format : "wav";
  const encoding = format === "wav" && info.float ? "float" : "pcm";
  const depths: readonly number[] =
    format === "flac" ? [8, 16, 24] : encoding === "float" ? FLOAT_DEPTHS : PCM_DEPTHS;
  return {
    format,
    encoding,
    bitDepth: depths.includes(info.bitDepth) ? info.bitDepth : encoding === "float" ? 32 : 24,
    scope: "document",
    dither: "none",
    noiseShaping: "none",
  };
}

export function updateExportSettings(
  previous: ExportSettings,
  change: Partial<ExportSettings>,
): ExportSettings {
  const settings = { ...previous, ...change };
  if (settings.format && settings.format !== "wav") settings.encoding = "pcm";
  const depths: readonly number[] = exportDepths(settings);
  if (!depths.includes(settings.bitDepth))
    settings.bitDepth = settings.encoding === "float" ? 32 : 24;
  if (settings.encoding === "float") {
    settings.dither = "none";
    settings.noiseShaping = "none";
  }
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
export function exportName(
  name: string,
  format: DocumentExportParams["format"],
  selection = false,
): string {
  if (!selection && name.toLowerCase().endsWith(`.${format}`)) return name;
  return `${name.replace(/\.[^./]*$/, "") || "Untitled"}${selection ? "-selection" : ""}.${format}`;
}
export function exportFileTypes(format: DocumentExportParams["format"]) {
  const mime = { wav: "audio/wav", flac: "audio/flac", aiff: "audio/aiff" }[format];
  return [{ description: `${format.toUpperCase()} audio`, accept: { [mime]: [`.${format}`] } }];
}
