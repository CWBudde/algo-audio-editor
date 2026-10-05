import { readFile } from "node:fs/promises";
import path from "node:path";

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

/** Malformed URLs and escapes receive responses without escaping the handler. */
export async function appResponse(requestURL: string, webRoot: string): Promise<Response> {
  try {
    const url = new URL(requestURL);
    if (url.protocol !== "app:" || url.host !== "editor" || url.username || url.password)
      return new Response("not found", { status: 404 });
    const relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = path.normalize(path.join(webRoot, relative));
    if (!file.startsWith(webRoot + path.sep)) return new Response("forbidden", { status: 403 });
    const body = await readFile(file);
    return new Response(body, {
      headers: {
        "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Content-Security-Policy": CSP,
      },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
