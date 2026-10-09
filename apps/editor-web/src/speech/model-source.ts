import type { DesktopBridge, SpeechDownloadProgress } from "@/platform";
import type {
  SpeechCatalog,
  SpeechCatalogFile,
  SpeechCatalogModel,
  SpeechLoaded,
  SpeechSourceFile,
} from "./messages";

/** The catalog files a model and voice still need, given what the worker holds. */
export interface SpeechFiles {
  weights?: SpeechCatalogFile;
  tokenizer?: SpeechCatalogFile;
  voiceFile?: SpeechCatalogFile;
}

export function findSpeechModel(catalog: SpeechCatalog, model: string): SpeechCatalogModel {
  const entry = catalog.models.find((candidate) => candidate.name === model);
  if (!entry) throw new Error(`Unknown speech model ${model}`);
  return entry;
}

/** Weights and tokenizer only when another (or no) model is loaded; the voice only when absent. */
export function missingSpeechFiles(
  catalog: SpeechCatalog,
  model: string,
  voice: string,
  loaded?: SpeechLoaded,
): SpeechFiles {
  const entry = findSpeechModel(catalog, model);
  const voiceEntry = entry.voices.find((candidate) => candidate.id === voice);
  if (!voiceEntry) throw new Error(`Speech model ${model} has no voice ${voice}`);
  const modelLoaded = loaded?.model === model;
  const { id: _id, ...voiceFile } = voiceEntry;
  return {
    ...(modelLoaded ? {} : { weights: entry.weights, tokenizer: entry.tokenizer }),
    ...(modelLoaded && loaded.voices.includes(voice) ? {} : { voiceFile }),
  };
}

export function speechFileList(files: SpeechFiles): SpeechCatalogFile[] {
  return [files.weights, files.tokenizer, files.voiceFile].filter(
    (file): file is SpeechCatalogFile => file !== undefined,
  );
}

/** Bytes a model download needs: weights plus tokenizer. */
export function speechModelBytes(model: SpeechCatalogModel): number {
  return model.weights.size + model.tokenizer.size;
}

function abortError() {
  return new DOMException("Speech generation cancelled", "AbortError");
}

/** `base` + catalog path, one encoded segment at a time. */
export function desktopSpeechUrl(base: string, path: string): string {
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return `${prefix}${path.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Decides where the worker fetches each file. The web build fetches the pinned
 * Hugging Face URLs directly, relying on the browser HTTP cache. Electron's
 * renderer may only connect to itself, so the main process downloads into
 * userData first and serves the files from app://.
 */
export async function resolveSpeechSources(
  files: SpeechFiles,
  options: {
    bridge?: DesktopBridge;
    signal?: AbortSignal;
    onProgress?(progress: SpeechDownloadProgress): void;
  } = {},
): Promise<{
  weights?: SpeechSourceFile;
  tokenizer?: SpeechSourceFile;
  voiceFile?: SpeechSourceFile;
}> {
  const list = speechFileList(files);
  const ensure = options.bridge?.ensureSpeechModels?.bind(options.bridge);
  let resolve = (file: SpeechCatalogFile): SpeechSourceFile => ({ ...file, source: file.url });
  if (ensure && list.length) {
    if (options.signal?.aborted) throw abortError();
    const unsubscribe = options.bridge?.onSpeechModelsProgress?.((progress) =>
      options.onProgress?.(progress),
    );
    const abort = () => void options.bridge?.cancelSpeechModels?.().catch(() => {});
    options.signal?.addEventListener("abort", abort, { once: true });
    let base: string;
    try {
      base = await ensure(list);
    } catch (error) {
      if (options.signal?.aborted) throw abortError();
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abort);
      unsubscribe?.();
    }
    if (options.signal?.aborted) throw abortError();
    resolve = (file) => ({ ...file, source: desktopSpeechUrl(base, file.path) });
  }
  return {
    ...(files.weights && { weights: resolve(files.weights) }),
    ...(files.tokenizer && { tokenizer: resolve(files.tokenizer) }),
    ...(files.voiceFile && { voiceFile: resolve(files.voiceFile) }),
  };
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Fetches a catalog file and returns its bytes only when size and SHA-256
 * match; a corrupt or substituted file is never handed to the model loader.
 * `onProgress` receives the bytes received so far.
 */
export async function fetchVerified(
  file: SpeechSourceFile,
  options: { signal?: AbortSignal; onProgress?(received: number): void; fetch?: typeof fetch } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const response = await (options.fetch ?? fetch)(file.source, { signal: options.signal });
  if (!response.ok)
    throw new Error(`Download of ${file.path} failed: ${response.status} ${response.statusText}`);
  const mismatch = () =>
    new Error(`Download of ${file.path} does not match the pinned catalog (size or SHA-256)`);
  const bytes = new Uint8Array(file.size);
  let received = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (received + value.byteLength > bytes.byteLength) throw mismatch();
        bytes.set(value, received);
        received += value.byteLength;
        options.onProgress?.(received);
      }
    } catch (error) {
      void reader.cancel().catch(() => {});
      throw error;
    }
  } else {
    const whole = new Uint8Array(await response.arrayBuffer());
    if (whole.byteLength > bytes.byteLength) throw mismatch();
    bytes.set(whole);
    received = whole.byteLength;
    options.onProgress?.(received);
  }
  if (options.signal?.aborted) throw abortError();
  if (received !== file.size) throw mismatch();
  const digest = hex(await crypto.subtle.digest("SHA-256", bytes));
  if (digest !== file.sha256.toLowerCase()) throw mismatch();
  return bytes;
}
