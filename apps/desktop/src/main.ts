/**
 * Electron main process. It hosts the same production build of the web app
 * that GitHub Pages serves, so browser and desktop run one code path.
 *
 * The build is served over a privileged app:// scheme rather than file://
 * because the editor needs cross-origin isolation (SharedArrayBuffer for the
 * playback ring buffer), and only a protocol handler can attach the required
 * COOP/COEP headers.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, protocol, shell } from "electron";

import { registerEffectPresets } from "./effect-presets";

const SCHEME = "app";
const HOST = "editor";
const APP_URL = `${SCHEME}://${HOST}/index.html`;

/** Set to the Vite dev server URL to develop against hot reload instead of dist. */
const DEV_URL = process.env.AAE_DEV_URL;

// Paths are derived from app.getAppPath() (this package's root), never from
// __dirname: the bundler inlines __dirname as the *source* directory.
const WEB_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, "web")
  : path.resolve(app.getAppPath(), "../editor-web/dist");
const PRELOAD = path.join(app.getAppPath(), "dist", "preload.js");

/**
 * Production CSP. 'wasm-unsafe-eval' is what WebAssembly compilation needs;
 * inline styles come from the toast and slider components.
 */
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
  ".woff2": "font/woff2",
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true,
    },
  },
]);

function registerAppProtocol() {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== HOST) return new Response("not found", { status: 404 });

    const relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = path.normalize(path.join(WEB_ROOT, relative));
    if (!file.startsWith(WEB_ROOT + path.sep)) {
      return new Response("forbidden", { status: 403 });
    }

    try {
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
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: "#0a0a0a",
    title: "algo-audio-editor",
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // The editor is a single page: keep navigation inside the app and send any
  // external link to the system browser.
  secureWindow(win);
  void win.loadURL(DEV_URL ?? APP_URL);
}

function secureWindow(win: BrowserWindow) {
  const application = new URL(DEV_URL ?? APP_URL);
  const sameApplication = (url: URL) =>
    url.protocol === application.protocol && url.host === application.host;
  win.webContents.on("will-navigate", (event, target) => {
    if (!sameApplication(new URL(target))) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    const target = new URL(url);
    if (
      sameApplication(target) &&
      target.pathname === application.pathname &&
      /^[0-9a-f-]{36}$/i.test(target.searchParams.get("extract") ?? "")
    ) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 1280,
          height: 800,
          minWidth: 800,
          minHeight: 500,
          backgroundColor: "#0a0a0a",
          webPreferences: {
            preload: PRELOAD,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      };
    }
    if (url.startsWith("https:")) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("did-create-window", (child) => secureWindow(child));
}

app.whenReady().then(() => {
  registerAppProtocol();
  registerEffectPresets(DEV_URL ?? APP_URL);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
