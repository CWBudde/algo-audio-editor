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
import { app, BrowserWindow, dialog, protocol, shell } from "electron";

import { registerDesktop } from "./desktop";
import { registerEffectPresets } from "./effect-presets";
import { registerFiles } from "./files";
import { registerUpdates } from "./updates";
import { loadWindowState, persistWindowState } from "./window-state";

const SCHEME = "app";
const HOST = "editor";
const APP_URL = `${SCHEME}://${HOST}/index.html`;

/** Set to the Vite dev server URL to develop against hot reload instead of dist. */
const DEV_URL = app.isPackaged ? undefined : process.env.AAE_DEV_URL;
// An optional separate profile also isolates packaged-runtime tests.
if (process.env.AAE_USER_DATA) app.setPath("userData", process.env.AAE_USER_DATA);
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
const initialFiles: string[] = [];
const argumentFiles = (argv: string[]) =>
  argv
    .filter((arg) => !arg.startsWith("-") && path.extname(arg).toLowerCase() === ".wav")
    .map((file) => path.resolve(file));
initialFiles.push(...argumentFiles(process.argv.slice(app.isPackaged ? 1 : 2)));
let desktop: ReturnType<typeof registerDesktop>;
let files: ReturnType<typeof registerFiles>;
let primaryWindow: BrowserWindow | undefined;
let desktopReady = false;
let quitRequested = false;
const persistence = new Set<() => Promise<void>>();
let persistenceFlushed = false;
async function openFiles(inputs: string[]) {
  if (!primaryWindow || primaryWindow.isDestroyed()) await createWindow();
  const win = primaryWindow;
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
  for (const input of inputs) {
    try {
      await files.enqueue(win, input);
    } catch (error) {
      void dialog.showMessageBox(win, {
        type: "error",
        message: "Could not open audio",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
app.on("second-instance", (_event, argv, workingDirectory) => {
  const inputs = argv
    .filter((arg) => !arg.startsWith("-") && path.extname(arg).toLowerCase() === ".wav")
    .map((file) => path.resolve(workingDirectory, file));
  if (desktopReady) void openFiles(inputs);
  else initialFiles.push(...inputs);
});
app.on("open-file", (event, file) => {
  event.preventDefault();
  if (desktopReady) void openFiles([file]);
  else initialFiles.push(file);
});

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

let openingWindow: Promise<BrowserWindow> | undefined;
function createWindow() {
  openingWindow ??= makeWindow().finally(() => {
    openingWindow = undefined;
  });
  return openingWindow;
}

async function makeWindow() {
  const state = await loadWindowState();
  const win = new BrowserWindow({
    ...state,
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
  primaryWindow = win;
  attachWindow(win, true);
  if (state.maximized) win.maximize();
  secureWindow(win);
  await win
    .loadURL(DEV_URL ?? APP_URL)
    .catch((error: Error & { code?: string; errno?: number }) => {
      if (error.code !== "ERR_ABORTED" && error.errno !== -3) throw error;
    });
  return win;
}

function attachWindow(win: BrowserWindow, persist = false) {
  files.attach(win);
  desktop(win);
  if (persist) {
    const flush = persistWindowState(win);
    persistence.add(flush);
    win.on("closed", () => {
      void flush().finally(() => persistence.delete(flush));
    });
  }
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
  win.webContents.on("did-create-window", (child) => {
    attachWindow(child);
    secureWindow(child);
  });
}

if (singleInstance) {
  app
    .whenReady()
    .then(async () => {
      registerAppProtocol();
      registerEffectPresets(DEV_URL ?? APP_URL);
      files = registerFiles(DEV_URL ?? APP_URL);
      desktop = registerDesktop(DEV_URL ?? APP_URL, () => {
        void checkUpdates();
      });
      const checkUpdates = registerUpdates();
      await createWindow();
      desktopReady = true;
      await openFiles(initialFiles.splice(0));
      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) void createWindow();
      });
    })
    .catch((error) => {
      console.error("Could not start desktop editor", error);
      app.quit();
    });
}

app.on("before-quit", () => {
  quitRequested = true;
});

app.on("will-quit", (event) => {
  if (persistenceFlushed) return;
  event.preventDefault();
  void Promise.all([...persistence].map((flush) => flush())).finally(() => {
    persistenceFlushed = true;
    app.quit();
  });
});
app.on("window-all-closed", () => {
  if (quitRequested || process.platform !== "darwin") app.quit();
});
