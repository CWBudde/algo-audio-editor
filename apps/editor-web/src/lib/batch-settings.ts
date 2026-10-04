import type { DocumentExportParams } from "@aae/protocol";

export type BatchFormat = NonNullable<DocumentExportParams["format"]>;
export interface BatchSettings {
  format: BatchFormat;
  encoding: "pcm" | "float";
  bitDepth: number;
  suffix: string;
}
export const DEFAULT_BATCH_SETTINGS: BatchSettings = {
  format: "flac",
  encoding: "pcm",
  bitDepth: 16,
  suffix: "-processed",
};

function reservedCharacters(value: string): boolean {
  return (
    /[<>:"/\\|?*]/.test(value) ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

export function batchDepths(settings: BatchSettings): readonly number[] {
  return settings.format === "flac"
    ? [8, 16, 24]
    : settings.encoding === "float"
      ? [32, 64]
      : [8, 16, 24, 32];
}

export function updateBatchSettings(
  previous: BatchSettings,
  change: Partial<BatchSettings>,
): BatchSettings {
  const next = { ...previous, ...change };
  if (next.format !== "wav") next.encoding = "pcm";
  if (!batchDepths(next).includes(next.bitDepth))
    next.bitDepth = next.encoding === "float" ? 32 : 16;
  return next;
}

/** Portable leaf names only; no directory paths are ever derived from inputs. */
function validateName(name: string): void {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    reservedCharacters(name) ||
    /[. ]$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ||
    new TextEncoder().encode(name).byteLength > 255
  )
    throw new Error(`Invalid output filename: ${name}`);
}

export function batchOutputNames(files: readonly Pick<File, "name">[], settings: BatchSettings) {
  if (!files.length) throw new Error("Choose at least one audio file.");
  if (
    !["wav", "flac", "aiff"].includes(settings.format) ||
    !batchDepths(settings).includes(settings.bitDepth) ||
    (settings.encoding === "float" && settings.format !== "wav")
  )
    throw new Error("Choose a supported output format and bit depth.");
  if (reservedCharacters(settings.suffix))
    throw new Error("Output suffix must not contain path separators or reserved characters.");
  const seen = new Set<string>();
  return files.map((file) => {
    const stem = file.name.replace(/\.[^./]*$/, "");
    const name = `${stem}${settings.suffix}.${settings.format}`;
    validateName(name);
    const key = name.normalize("NFC").toLocaleLowerCase("en-US");
    if (seen.has(key)) throw new Error(`Duplicate output filename: ${name}`);
    seen.add(key);
    return name;
  });
}
