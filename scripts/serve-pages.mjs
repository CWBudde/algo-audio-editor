// Test server deliberately has no COOP/COEP headers: isolation must come from
// the production service worker, under a real repository subpath.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = fileURLToPath(new URL("../apps/editor-web/dist-pages/", import.meta.url));
const base = "/algo-audio-editor/";
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".wav": "audio/wav", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2" };
createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    if (!pathname.startsWith(base)) {
      response.writeHead(404).end();
      return;
    }
    const relative = pathname.slice(base.length) || "index.html";
    const filename = path.resolve(root, relative);
    if (!filename.startsWith(root)) {
      response.writeHead(403).end();
      return;
    }
    let data;
    try { data = await readFile(filename); } catch {
      response.writeHead(404, { "Content-Type": "text/html" });
      response.end(await readFile(path.join(root, "404.html")));
      return;
    }
    // Pages compresses WASM and text; test reconstructed streaming responses
    // with the same encoded headers rather than only uncompressed localhost.
    const compressed = gzipSync(data);
    response.writeHead(200, { "Content-Type": mime[path.extname(filename)] ?? "application/octet-stream", "Cache-Control": "max-age=600", "Content-Encoding": "gzip", "Content-Length": compressed.length });
    response.end(compressed);
  } catch { response.writeHead(400).end(); }
}).listen(Number(process.argv[2]), "localhost");
