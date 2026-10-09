/**
 * Pure validation of speech model catalog paths and download URLs. Shared by
 * the download handlers and the app:// protocol, and free of Electron imports
 * so both can be tested in plain Node.
 */
import type { SpeechModelFile } from "../../editor-web/src/platform";

/** URL prefix under which the renderer reads downloaded model files. */
export const SPEECH_MODELS_PREFIX = "/speech-models/";
export const MAX_SPEECH_MODEL_FILES = 40;
export const MAX_SPEECH_MODEL_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_PATH_SEGMENTS = 6;
const MAX_SEGMENT_LENGTH = 128;
const SEGMENT = /^[A-Za-z0-9._-]+$/;
// Windows device names refuse to be files, with or without an extension.
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
const REVISION = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function safeSegment(segment: string) {
  return (
    segment.length > 0 &&
    segment.length <= MAX_SEGMENT_LENGTH &&
    SEGMENT.test(segment) &&
    !segment.startsWith(".") &&
    !segment.endsWith(".") &&
    !RESERVED.test(segment)
  );
}

/**
 * Splits a slash-separated catalog path such as "german/voices/juergen.safetensors"
 * into its segments, or returns undefined when it is not an allowed model file path.
 */
export function speechModelSegments(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const segments = value.split("/");
  if (segments.length > MAX_PATH_SEGMENTS || !segments.every(safeSegment)) return undefined;
  const name = segments[segments.length - 1];
  if (!name.endsWith(".safetensors") && name !== "tokenizer.model" && name !== "tokenizer.json")
    return undefined;
  return segments;
}

/** True for the pinned https://huggingface.co/<org>/<repo>/resolve/<revision>/<file> form. */
export function pinnedModelURL(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // Requiring the canonical serialization rules out dot segments, escapes,
  // default ports and other spellings that normalize to something else.
  if (
    url.href !== value ||
    url.protocol !== "https:" ||
    url.hostname !== "huggingface.co" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return false;
  const [empty, org, repo, resolve, revision, ...file] = url.pathname.split("/");
  return (
    empty === "" &&
    resolve === "resolve" &&
    REVISION.test(revision ?? "") &&
    file.length >= 1 &&
    file.length <= MAX_PATH_SEGMENTS &&
    [org, repo, ...file].every((segment) => segment !== undefined && safeSegment(segment))
  );
}

/** Hugging Face serves LFS/Xet files from CDN hosts below hf.co. */
export function allowedRedirect(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.port &&
      !url.username &&
      !url.password &&
      (url.hostname === "huggingface.co" || url.hostname.endsWith(".hf.co"))
    );
  } catch {
    return false;
  }
}

/** Validates an untrusted renderer request; throws on the first invalid entry. */
export function parseSpeechModelFiles(input: unknown): SpeechModelFile[] {
  if (!Array.isArray(input) || !input.length || input.length > MAX_SPEECH_MODEL_FILES)
    throw new Error("Invalid speech model request: file list");
  const seen = new Set<string>();
  return input.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw new Error("Invalid speech model request: entry");
    const { url, sha256, size, path } = entry as Record<string, unknown>;
    if (!pinnedModelURL(url)) throw new Error("Invalid speech model request: url");
    if (typeof sha256 !== "string" || !SHA256.test(sha256))
      throw new Error("Invalid speech model request: sha256");
    if (
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > MAX_SPEECH_MODEL_BYTES
    )
      throw new Error("Invalid speech model request: size");
    if (!speechModelSegments(path)) throw new Error("Invalid speech model request: path");
    const key = (path as string).toLowerCase();
    if (seen.has(key)) throw new Error("Invalid speech model request: duplicate path");
    seen.add(key);
    return { url, sha256, size, path: path as string };
  });
}

/** The pinned catalog files by path: the only files main downloads. */
export type SpeechCatalogFiles = ReadonlyMap<string, SpeechModelFile>;

/**
 * Indexes the go-pocket-tts catalog JSON the web build ships as
 * speech-catalog.json. Every entry must itself be a valid request.
 */
export function parseSpeechCatalog(json: string): SpeechCatalogFiles {
  const catalog = JSON.parse(json) as { models?: unknown };
  if (!Array.isArray(catalog.models)) throw new Error("Invalid speech model catalog");
  const files: unknown[] = [];
  for (const model of catalog.models as Record<string, unknown>[]) {
    files.push(model.weights, model.tokenizer);
    if (!Array.isArray(model.voices)) throw new Error("Invalid speech model catalog");
    for (const { id: _id, ...voice } of model.voices as Record<string, unknown>[])
      files.push(voice);
  }
  const index = new Map<string, SpeechModelFile>();
  for (let offset = 0; offset < files.length; offset += MAX_SPEECH_MODEL_FILES)
    for (const file of parseSpeechModelFiles(files.slice(offset, offset + MAX_SPEECH_MODEL_FILES)))
      index.set(file.path, file);
  return index;
}

/** Rejects requested files that are not exactly the catalog's pinned file at their path. */
export function requireCatalogFiles(files: SpeechModelFile[], catalog: SpeechCatalogFiles) {
  for (const file of files) {
    const pinned = catalog.get(file.path);
    if (
      !pinned ||
      pinned.url !== file.url ||
      pinned.sha256 !== file.sha256 ||
      pinned.size !== file.size
    )
      throw new Error(
        `Invalid speech model request: ${file.path} is not in the speech model catalog`,
      );
  }
}
