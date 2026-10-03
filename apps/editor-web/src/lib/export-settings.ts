import type {
  DocumentExportParams,
  DocumentInfoResult,
  ExportDither,
  ExportNoiseShaping,
  ExportScope,
  SelectionRange,
} from "@aae/protocol";

export interface ExportSettings {
  encoding: "pcm" | "float";
  bitDepth: number;
  scope: ExportScope;
  dither: ExportDither;
  noiseShaping: ExportNoiseShaping;
}

export const PCM_DEPTHS = [8, 16, 24, 32] as const;
export const FLOAT_DEPTHS = [32, 64] as const;

export function defaultExportSettings(info: DocumentInfoResult): ExportSettings {
  const encoding = info.float ? "float" : "pcm";
  const depths: readonly number[] = info.float ? FLOAT_DEPTHS : PCM_DEPTHS;
  return {
    encoding,
    bitDepth: depths.includes(info.bitDepth) ? info.bitDepth : info.float ? 32 : 24,
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
  const depths: readonly number[] = settings.encoding === "float" ? FLOAT_DEPTHS : PCM_DEPTHS;
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
  const depths: readonly number[] = settings.encoding === "float" ? FLOAT_DEPTHS : PCM_DEPTHS;
  if (
    !depths.includes(settings.bitDepth) ||
    (settings.scope === "selection" && !validExportSelection(selection, info))
  )
    return;
  return {
    documentId: info.documentId,
    format: "wav",
    bitDepth: settings.bitDepth,
    float: settings.encoding === "float",
    scope: settings.scope,
    dither: settings.encoding === "float" ? "none" : settings.dither,
    noiseShaping: settings.encoding === "float" ? "none" : settings.noiseShaping,
  };
}
