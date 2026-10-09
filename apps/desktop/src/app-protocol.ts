import { constants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { SPEECH_MODELS_PREFIX, speechModelSegments } from "./speech-model-paths";

// WebAssembly compilation needs wasm-unsafe-eval; UI sliders/toasts use inline styles.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const headers = (contentType: string) => ({
  "Content-Type": contentType,
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Content-Security-Policy": CSP,
});

/**
 * Streams a downloaded speech model. Model weights reach 1.3 GB, so they are
 * never buffered; only validated catalog paths below the model root are served.
 */
async function speechModelResponse(pathname: string, speechRoot: string | undefined) {
  if (!speechRoot) return new Response("not found", { status: 404 });
  const segments = speechModelSegments(
    decodeURIComponent(pathname.slice(SPEECH_MODELS_PREFIX.length)),
  );
  if (!segments) return new Response("forbidden", { status: 403 });
  const file = path.join(speechRoot, ...segments);
  if (!file.startsWith(speechRoot + path.sep)) return new Response("forbidden", { status: 403 });
  // The lexical check cannot see a symlinked folder below the root; resolve the
  // parent and require it inside the resolved root. O_NOFOLLOW covers the file.
  const [realRoot, realParent] = await Promise.all([
    realpath(speechRoot),
    realpath(path.dirname(file)),
  ]);
  if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep))
    return new Response("forbidden", { status: 403 });
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("not a file");
    const body = Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array>;
    return new Response(body, {
      headers: {
        ...headers(file.endsWith(".json") ? "application/json" : "application/octet-stream"),
        "Content-Length": String(stat.size),
      },
    });
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Malformed URLs and escapes receive responses without escaping the handler. */
export async function appResponse(
  requestURL: string,
  webRoot: string,
  speechRoot?: string,
): Promise<Response> {
  try {
    const url = new URL(requestURL);
    if (url.protocol !== "app:" || url.host !== "editor" || url.username || url.password)
      return new Response("not found", { status: 404 });
    if (url.pathname.startsWith(SPEECH_MODELS_PREFIX))
      return await speechModelResponse(url.pathname, speechRoot);
    const relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = path.normalize(path.join(webRoot, relative));
    if (!file.startsWith(webRoot + path.sep)) return new Response("forbidden", { status: 403 });
    const body = await readFile(file);
    return new Response(body, {
      headers: headers(MIME[path.extname(file)] ?? "application/octet-stream"),
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
