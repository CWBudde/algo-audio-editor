/**
 * Speech model downloads for the desktop app. The main process fetches the
 * pinned go-pocket-tts files into userData/speech-models, verifies them, and
 * the app:// protocol serves them to the renderer at app://editor/speech-models/,
 * so the renderer CSP stays connect-src 'self' and the page never reaches the network.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { app, type BrowserWindow, ipcMain, net } from "electron";
import type { SpeechDownloadProgress, SpeechModelFile } from "../../editor-web/src/platform";
import { trustedWindow } from "./ipc";
import {
  allowedRedirect,
  parseSpeechCatalog,
  parseSpeechModelFiles,
  requireCatalogFiles,
  SPEECH_MODELS_PREFIX,
  type SpeechCatalogFiles,
  speechModelSegments,
} from "./speech-model-paths";

export const SPEECH_MODELS_URL = `app://editor${SPEECH_MODELS_PREFIX}`;
const MAX_REDIRECTS = 5;
const PROGRESS_INTERVAL_MS = 100;
const PART = /\.[0-9a-f-]{36}\.part$/;

export function speechModelsRoot() {
  return path.join(app.getPath("userData"), "speech-models");
}

const cancelled = () => new Error("cancelled");

interface Download {
  owner: number;
  controller: AbortController;
}
interface VerifiedHash {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  sha256: string;
}

interface ModelResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  /** Electron's IncomingMessage is a Readable at runtime; its typings omit that. */
  body: AsyncIterable<Buffer>;
  /** Aborts the request and detaches it from the cancellation signal. */
  close: () => void;
}

/** Opens a GET whose redirects are followed only to Hugging Face hosts. */
function request(url: string, signal: AbortSignal) {
  return new Promise<ModelResponse>((resolve, reject) => {
    if (signal.aborted) return reject(cancelled());
    // net.request uses Chromium's network stack and the system proxy. net.fetch
    // rejects every redirect in "manual" mode, so it cannot gate redirect hosts.
    const req = net.request({
      url,
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      useSessionCookies: false,
      cache: "no-store",
    });
    const abort = () => {
      req.abort();
      reject(cancelled());
    };
    const close = () => {
      signal.removeEventListener("abort", abort);
      req.abort();
    };
    const fail = (error: Error) => {
      close();
      reject(error);
    };
    signal.addEventListener("abort", abort, { once: true });
    let redirects = 0;
    req.on("redirect", (_status: number, _method: string, target: string) => {
      if (++redirects > MAX_REDIRECTS) return fail(new Error("Too many redirects"));
      if (!allowedRedirect(target)) return fail(new Error("Redirect to an unexpected host"));
      req.followRedirect();
    });
    req.on("response", (response) => {
      // An aborted, unconsumed body must not surface as an uncaught stream error.
      response.on("error", () => {});
      resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: response as unknown as AsyncIterable<Buffer>,
        close,
      });
    });
    req.on("error", fail);
    req.end();
  });
}

const missing = (error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return undefined;
  throw error;
};

/**
 * Creates a model's folders below root one at a time. mkdir -p would follow a
 * symlinked folder out of the root; here a symlink or file in the way is refused.
 */
async function ensureDirectories(root: string, segments: string[]) {
  await mkdir(root, { recursive: true });
  let directory = root;
  for (const segment of segments) {
    directory = path.join(directory, segment);
    let stat = await lstat(directory).catch(missing);
    if (!stat) {
      await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      stat = await lstat(directory);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(`Speech model folder is not a plain directory: ${segments.join("/")}`);
  }
}

async function hashFile(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

// ctime cannot be set back by a writer, so any change to the file invalidates the hash.
const fingerprint = (stat: Stats, sha256: string): VerifiedHash => ({
  size: stat.size,
  mtimeMs: stat.mtimeMs,
  ctimeMs: stat.ctimeMs,
  ino: stat.ino,
  sha256,
});
const sameFile = (cached: VerifiedHash, stat: Stats) =>
  cached.size === stat.size &&
  cached.mtimeMs === stat.mtimeMs &&
  cached.ctimeMs === stat.ctimeMs &&
  cached.ino === stat.ino;

/** Loads the catalog JSON once; a failed read is retried on the next request. */
export function catalogFile(file: string): () => Promise<SpeechCatalogFiles> {
  let loaded: Promise<SpeechCatalogFiles> | undefined;
  return () =>
    (loaded ??= readFile(file, "utf8")
      .then(parseSpeechCatalog)
      .catch((error: unknown) => {
        loaded = undefined;
        throw new Error(
          `Speech model catalog unavailable: ${error instanceof Error ? error.message : error}`,
        );
      }));
}

/**
 * catalog yields the pinned catalog the app ships (speech-catalog.json); a
 * request for any other file is refused before the network is touched.
 */
export function registerSpeechModels(
  applicationURL: string,
  catalog: () => Promise<SpeechCatalogFiles>,
) {
  const verified = new Map<string, VerifiedHash>();
  let active: Download | undefined;

  const present = async (file: string, model: SpeechModelFile) => {
    const stat = await lstat(file).catch(missing);
    if (!stat) return false;
    if (stat.isDirectory()) throw new Error(`Speech model path is a folder: ${model.path}`);
    if (stat.isFile() && stat.size === model.size) {
      const cached = verified.get(file);
      const sha256 = cached && sameFile(cached, stat) ? cached.sha256 : await hashFile(file);
      verified.set(file, fingerprint(stat, sha256));
      if (sha256 === model.sha256) return true;
    }
    // Corrupt, truncated, replaced or symlinked: never serve it, fetch it again.
    verified.delete(file);
    await unlink(file);
    return false;
  };

  const download = async (
    file: string,
    model: SpeechModelFile,
    signal: AbortSignal,
    received: (bytes: number) => void,
  ) => {
    const temporary = `${file}.${randomUUID()}.part`;
    const response = await request(model.url, signal);
    try {
      if (response.statusCode !== 200)
        throw new Error(`Download failed with HTTP ${response.statusCode}: ${model.path}`);
      const length = Number(response.headers["content-length"]);
      if (response.headers["content-length"] !== undefined && length !== model.size)
        throw new Error(`Unexpected download size: ${model.path}`);
      const hash = createHash("sha256");
      let bytes = 0;
      const handle = await open(temporary, "wx", 0o600);
      try {
        for await (const data of response.body) {
          bytes += data.length;
          if (bytes > model.size)
            throw new Error(`Download is larger than expected: ${model.path}`);
          hash.update(data);
          await handle.write(data);
          received(data.length);
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (bytes !== model.size) throw new Error(`Download is incomplete: ${model.path}`);
      const sha256 = hash.digest("hex");
      if (sha256 !== model.sha256) throw new Error(`Checksum mismatch: ${model.path}`);
      if (signal.aborted) throw cancelled();
      await rename(temporary, file);
      verified.set(file, fingerprint(await lstat(file), sha256));
    } catch (error) {
      throw signal.aborted ? cancelled() : error;
    } finally {
      response.close();
      await unlink(temporary).catch(() => {});
    }
  };

  /** Removes .part files a crashed or killed download left beside a model file. */
  const removeStaleParts = async (file: string) => {
    const directory = path.dirname(file);
    const name = path.basename(file);
    const entries = await readdir(directory).catch(() => [] as string[]);
    for (const entry of entries)
      if (entry.startsWith(`${name}.`) && PART.test(entry.slice(name.length)))
        await unlink(path.join(directory, entry)).catch(() => {});
  };

  ipcMain.handle("speech-models.ensure", async (event, input: unknown) => {
    const win = trustedWindow(event, applicationURL);
    const models = parseSpeechModelFiles(input);
    requireCatalogFiles(models, await catalog());
    if (active) throw new Error("A speech model download is already running");
    const job: Download = { owner: win.webContents.id, controller: new AbortController() };
    active = job;
    const { signal } = job.controller;
    const total = models.reduce((sum, model) => sum + model.size, 0);
    let done = 0;
    let last = 0;
    const report = (model: SpeechModelFile, force: boolean) => {
      const now = Date.now();
      if (!force && now - last < PROGRESS_INTERVAL_MS) return;
      last = now;
      if (win.isDestroyed()) return;
      const progress: SpeechDownloadProgress = { path: model.path, done, total };
      win.webContents.send("speech-models.progress", progress);
    };
    try {
      const root = speechModelsRoot();
      for (const model of models) {
        if (signal.aborted) throw cancelled();
        const segments = speechModelSegments(model.path) as string[];
        const file = path.join(root, ...segments);
        await ensureDirectories(root, segments.slice(0, -1));
        await removeStaleParts(file);
        if (await present(file, model)) done += model.size;
        else
          await download(file, model, signal, (bytes) => {
            done += bytes;
            report(model, false);
          });
        report(model, true);
      }
      if (signal.aborted) throw cancelled();
      return SPEECH_MODELS_URL;
    } catch (error) {
      throw signal.aborted ? cancelled() : error;
    } finally {
      if (active === job) active = undefined;
    }
  });

  ipcMain.handle("speech-models.cancel", (event) => {
    const win = trustedWindow(event, applicationURL);
    if (active?.owner === win.webContents.id) active.controller.abort();
  });

  ipcMain.handle("speech-models.remove", async (event) => {
    trustedWindow(event, applicationURL);
    if (active) throw new Error("Cannot remove speech models while a download is running");
    verified.clear();
    await rm(speechModelsRoot(), { recursive: true, force: true });
  });

  ipcMain.handle("speech-models.usage", async (event) => {
    trustedWindow(event, applicationURL);
    let bytes = 0;
    const visit = async (directory: string) => {
      const entries = await readdir(directory, { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        },
      );
      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(entryPath);
        else if (entry.isFile()) bytes += (await lstat(entryPath)).size;
      }
    };
    await visit(speechModelsRoot());
    return bytes;
  });

  /** A window's download stops when its main frame navigates or it closes. */
  const attach = (win: BrowserWindow) => {
    const owner = win.webContents.id;
    const stop = () => {
      if (active?.owner === owner) active.controller.abort();
    };
    win.webContents.on("did-start-navigation", (_event, _url, _inPlace, mainFrame) => {
      if (mainFrame) stop();
    });
    win.on("closed", stop);
  };
  return { attach };
}
