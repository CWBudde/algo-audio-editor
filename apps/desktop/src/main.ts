/**
 * Electron main process. It hosts the same production build of the web app
 * that GitHub Pages serves, so browser and desktop run one code path.
 *
 * The build is served over a privileged app:// scheme rather than file://
 * because the editor needs cross-origin isolation (SharedArrayBuffer for the
 * playback ring buffer), and only a protocol handler can attach the required
 * COOP/COEP headers.
 */
import path from "node:path";
import { app, BrowserWindow, dialog, protocol, session, shell } from "electron";

import { appResponse } from "./app-protocol";

import { registerDesktop } from "./desktop";
import { registerEffectPresets } from "./effect-presets";
import { OPEN_EXTENSIONS, registerFiles } from "./files";
import {
  allowedExternalURL,
  isExtractionURL,
  registerPermissions,
  sameApplication,
} from "./security";
import { registerSpeechModels, speechModelsRoot } from "./speech-models";
import { registerUpdates } from "./updates";
import { loadWindowState, persistWindowState } from "./window-state";

const SCHEME = "app";
const HOST = "editor";
const APP_URL = `${SCHEME}://${HOST}/index.html`;

/** Set to the Vite dev server URL to develop against hot reload instead of dist. */
const DEV_URL = app.isPackaged ? undefined : process.env.AAE_DEV_URL;
// Development and unpackaged tests may use a separate profile. Production ignores it.
if (!app.isPackaged && process.env.AAE_USER_DATA)
  app.setPath("userData", process.env.AAE_USER_DATA);
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
const initialFiles: string[] = [];
const argumentFiles = (argv: string[]) =>
  argv
    .filter(
      (arg) =>
        !arg.startsWith("-") && OPEN_EXTENSIONS.has(path.extname(arg).slice(1).toLowerCase()),
    )
    .map((file) => path.resolve(file));
initialFiles.push(...argumentFiles(process.argv.slice(app.isPackaged ? 1 : 2)));
let desktop: ReturnType<typeof registerDesktop>;
let files: ReturnType<typeof registerFiles>;
let speechModels: ReturnType<typeof registerSpeechModels>;
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
    .filter(
      (arg) =>
        !arg.startsWith("-") && OPEN_EXTENSIONS.has(path.extname(arg).slice(1).toLowerCase()),
    )
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
const APP_ICON = path.join(WEB_ROOT, "app-icon.png");

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
  // userData is final here: AAE_USER_DATA is applied before the app is ready.
  const speechRoot = speechModelsRoot();
  protocol.handle(SCHEME, (request) => appResponse(request.url, WEB_ROOT, speechRoot));
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
    icon: APP_ICON,
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
  speechModels.attach(win);
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
  const applicationURL = DEV_URL ?? APP_URL;
  win.webContents.on("will-navigate", (event) => {
    if (!sameApplication(event.url, applicationURL)) event.preventDefault();
  });
  win.webContents.on("will-redirect", (event) => {
    if (!sameApplication(event.url, applicationURL)) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExtractionURL(url, applicationURL)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 1280,
          height: 800,
          minWidth: 800,
          minHeight: 500,
          backgroundColor: "#0a0a0a",
          icon: APP_ICON,
          webPreferences: {
            preload: PRELOAD,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      };
    }
    const external = allowedExternalURL(url);
    if (external) void shell.openExternal(external).catch(() => {});
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
      if (!app.isPackaged) app.dock?.setIcon(APP_ICON);
      registerPermissions(session.defaultSession, DEV_URL ?? APP_URL);
      registerAppProtocol();
      registerEffectPresets(DEV_URL ?? APP_URL);
      files = registerFiles(DEV_URL ?? APP_URL);
      speechModels = registerSpeechModels(DEV_URL ?? APP_URL);
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
