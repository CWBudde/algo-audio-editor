import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerFiles } from "./files";

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  windows: new Map<unknown, unknown>(),
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
  addRecentDocument: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { addRecentDocument: electron.addRecentDocument },
  BrowserWindow: { fromWebContents: (sender: unknown) => electron.windows.get(sender) },
  dialog: { showOpenDialog: electron.showOpenDialog, showSaveDialog: electron.showSaveDialog },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      electron.handlers.set(name, handler),
  },
}));

const applicationURL = "app://editor/index.html";
const createWindow = (id: number) => {
  const webContents = Object.assign(new EventEmitter(), {
    id,
    mainFrame: { url: applicationURL },
    send: vi.fn(),
  });
  const win = Object.assign(new EventEmitter(), { webContents, isDestroyed: vi.fn(() => false) });
  electron.windows.set(webContents, win);
  return win;
};
type TestWindow = ReturnType<typeof createWindow>;
const event = (win: TestWindow) => ({
  sender: win.webContents,
  senderFrame: win.webContents.mainFrame,
});
const invoke = <T = unknown>(name: string, win: TestWindow, ...args: unknown[]): Promise<T> =>
  Promise.resolve().then(() => electron.handlers.get(`files.${name}`)?.(event(win), ...args) as T);
interface Capability {
  id: string;
  name: string;
}
let directory: string;
let win: TestWindow;
let other: TestWindow;
let files: ReturnType<typeof registerFiles>;
const nativeWindow = (value: TestWindow) => value as unknown as BrowserWindow;
const inputFile = async (name = "source.wav") => {
  const file = path.join(directory, name);
  await writeFile(file, new Uint8Array([1, 2, 3, 4]));
  return file;
};
const openFile = async (file: string, owner = win) => {
  electron.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [file] });
  return invoke<Capability>("open", owner);
};
const saveFile = async (file: string, owner = win) => {
  electron.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: file });
  return invoke<Capability>("save", owner, "output.wav", ["wav"]);
};
const selectDirectory = async (folder = directory) => {
  electron.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [folder] });
  return invoke<Capability>("batch-directory", win);
};
const bytes = () => new Uint8Array([9, 8, 7]).buffer;

beforeEach(async () => {
  // The capabilities canonicalize paths; macOS tmpdir is a /var -> /private/var symlink.
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "aae-files-unit-")));
  electron.handlers.clear();
  electron.windows.clear();
  electron.showOpenDialog.mockReset();
  electron.showSaveDialog.mockReset();
  electron.addRecentDocument.mockClear();
  win = createWindow(1);
  other = createWindow(2);
  files = registerFiles(applicationURL);
  files.attach(nativeWindow(win));
  files.attach(nativeWindow(other));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("native file capabilities", () => {
  it("returns opaque ids and basenames, reads exact bytes once, then records a successful open", async () => {
    const file = await inputFile();
    const first = await openFile(file);
    const second = await openFile(file);
    expect(first).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), name: "source.wav" });
    expect(second.id).not.toBe(first.id);
    await expect(invoke("opened", win, first.id)).rejects.toThrow("not been read");
    const data = await invoke<ArrayBuffer>("read", win, first.id);
    expect(Array.from(new Uint8Array(data))).toEqual([1, 2, 3, 4]);
    await expect(invoke("read", win, first.id)).rejects.toThrow("already been read");
    await invoke("opened", win, first.id);
    expect(electron.addRecentDocument).toHaveBeenCalledWith(file);
    await expect(invoke("read", win, first.id)).rejects.toThrow("not authorized");
  });

  it("rejects paths, forged ids, wrong mode and cross-renderer reuse without consuming the owner's grant", async () => {
    const file = await inputFile();
    const read = await openFile(file);
    const write = await saveFile(path.join(directory, "output.wav"));
    for (const id of [file, "forged", null, { id: read.id }])
      await expect(invoke("read", win, id)).rejects.toThrow("not authorized");
    await expect(invoke("read", other, read.id)).rejects.toThrow("not authorized");
    await expect(invoke("release", other, read.id)).rejects.toThrow("not authorized");
    await expect(invoke("write", win, read.id, bytes())).rejects.toThrow("not authorized");
    await expect(invoke("read", win, write.id)).rejects.toThrow("not authorized");
    expect((await invoke<ArrayBuffer>("read", win, read.id)).byteLength).toBe(4);
    await invoke("write", win, write.id, bytes());
    expect(await readFile(path.join(directory, "output.wav"))).toEqual(Buffer.from([9, 8, 7]));
    await expect(invoke("write", win, write.id, bytes())).rejects.toThrow("not authorized");
  });

  it("rejects untrusted origins and subframes before presenting a dialog", async () => {
    const handler = electron.handlers.get("files.open");
    await expect(
      handler?.({ sender: win.webContents, senderFrame: { url: applicationURL } }),
    ).rejects.toThrow("Untrusted IPC sender");
    win.webContents.mainFrame.url = "https://example.com/";
    await expect(handler?.(event(win))).rejects.toThrow("Untrusted IPC origin");
    expect(electron.showOpenDialog).not.toHaveBeenCalled();
  });

  it.each(["navigation", "close"])(
    "revokes one renderer's grants on %s without revoking another's",
    async (kind) => {
      const file = await inputFile();
      const first = await openFile(file);
      const second = await openFile(file, other);
      if (kind === "navigation")
        win.webContents.emit("did-start-navigation", {}, applicationURL, false, true);
      else win.emit("closed");
      await expect(invoke("read", win, first.id)).rejects.toThrow("not authorized");
      expect((await invoke<ArrayBuffer>("read", other, second.id)).byteLength).toBe(4);
    },
  );

  it("retains a grant during subframe navigation and explicitly releases it", async () => {
    const grant = await openFile(await inputFile());
    win.webContents.emit("did-start-navigation", {}, "https://example.com/", false, false);
    await invoke("release", win, grant.id);
    await expect(invoke("read", win, grant.id)).rejects.toThrow("not authorized");
  });

  it.each([
    ["open", "navigation"],
    ["save", "navigation"],
    ["open", "close"],
    ["save", "close"],
  ])("does not grant late %s dialog results after %s", async (kind, invalidation) => {
    const file = await inputFile();
    let resolve!: (result: unknown) => void;
    const result = new Promise((done) => {
      resolve = done;
    });
    if (kind === "open") electron.showOpenDialog.mockReturnValueOnce(result);
    else electron.showSaveDialog.mockReturnValueOnce(result);
    const pending = invoke(kind, win, "output.wav", ["wav"]);
    await Promise.resolve();
    if (invalidation === "navigation")
      win.webContents.emit("did-start-navigation", {}, applicationURL, false, true);
    else win.emit("closed");
    resolve(
      kind === "open"
        ? { canceled: false, filePaths: [file] }
        : { canceled: false, filePath: file },
    );
    await expect(pending).rejects.toThrow("expired");
  });

  it("bounds outstanding file grants and makes capacity available after release", async () => {
    const file = await inputFile();
    const granted: Capability[] = [];
    for (let index = 0; index < 256; index++) granted.push(await openFile(file));
    await expect(openFile(file)).rejects.toThrow("Too many pending file requests");
    await invoke("release", win, granted[0].id);
    const replacement = await openFile(file);
    expect(replacement.id).not.toBe(granted[0].id);
  });

  it("returns null on canceled native dialogs", async () => {
    electron.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    electron.showSaveDialog.mockResolvedValueOnce({ canceled: true });
    await expect(invoke("open", win)).resolves.toBeNull();
    await expect(invoke("save", win, "out.wav", ["wav"])).resolves.toBeNull();
  });

  it.each([
    ["../out.wav", ["wav"]],
    ["out.wav", ["exe"]],
    ["out.wav", []],
    ["out.wav", ["wav", "flac", "aiff", "opus"]],
    ["x".repeat(256), ["wav"]],
  ])("rejects malformed save input %j before a dialog", async (name, extensions) => {
    await expect(invoke("save", win, name, extensions)).rejects.toThrow("Invalid save request");
    expect(electron.showSaveDialog).not.toHaveBeenCalled();
  });

  it("requires the dialog result to have an approved save extension", async () => {
    await expect(saveFile(path.join(directory, "out.exe"))).rejects.toThrow(
      "Unsupported save extension",
    );
  });

  it("reads a user-selected symlink's canonical target, but rejects replacement symlinks after approval", async () => {
    const file = await inputFile();
    const selectedLink = path.join(directory, "selected.wav");
    await symlink(file, selectedLink);
    const approved = await openFile(selectedLink);
    expect((await invoke<ArrayBuffer>("read", win, approved.id)).byteLength).toBe(4);
    const replacement = await openFile(file);
    const secret = await inputFile("secret.wav");
    await unlink(file);
    await symlink(secret, file);
    await expect(invoke("read", win, replacement.id)).rejects.toThrow();
  });

  it("rejects a sparse file larger than 1 GiB before allocating its contents", async () => {
    const file = await inputFile();
    await truncate(file, 1024 * 1024 * 1024 + 1);
    const approved = await openFile(file);
    await expect(invoke("read", win, approved.id)).rejects.toThrow("1 GiB import limit");
    expect(electron.addRecentDocument).not.toHaveBeenCalled();
  });

  it("rejects non-regular files even if the native dialog selected them", async () => {
    const approved = await openFile(directory);
    await expect(invoke("read", win, approved.id)).rejects.toThrow("1 GiB import limit");
  });

  it("does not overwrite a symlink destination or its target and removes failed grants", async () => {
    const target = await inputFile();
    const destination = path.join(directory, "output.wav");
    await symlink(target, destination);
    const approved = await saveFile(destination);
    await expect(invoke("write", win, approved.id, bytes())).rejects.toThrow("not a regular file");
    expect(await readFile(target)).toEqual(Buffer.from([1, 2, 3, 4]));
    await expect(invoke("write", win, approved.id, bytes())).rejects.toThrow("not authorized");
    expect((await readdir(directory)).sort()).toEqual(["output.wav", "source.wav"]);
  });

  it("rejects non-binary output without consuming a write grant", async () => {
    const approved = await saveFile(path.join(directory, "output.wav"));
    await expect(invoke("write", win, approved.id, new Uint8Array([1]))).rejects.toThrow(
      "Invalid file output",
    );
    await invoke("write", win, approved.id, bytes());
  });

  it("queues only supported canonical audio paths and consumes pending notifications once", async () => {
    const file = await inputFile();
    await files.enqueue(nativeWindow(win), file);
    expect(win.webContents.send).toHaveBeenCalledWith("files.pending");
    const pending = await invoke<Capability[]>("take", win);
    expect(pending).toEqual([{ id: expect.any(String), name: "source.wav" }]);
    expect(await invoke("take", win)).toEqual([]);
    expect(await invoke("take", other)).toEqual([]);
    expect((await invoke<ArrayBuffer>("read", win, pending[0].id)).byteLength).toBe(4);
    const unsupported = await inputFile("secret.txt");
    const misleading = path.join(directory, "misleading.wav");
    await symlink(unsupported, misleading);
    await expect(files.enqueue(nativeWindow(win), unsupported)).rejects.toThrow(
      "Unsupported audio extension",
    );
    await expect(files.enqueue(nativeWindow(win), misleading)).rejects.toThrow(
      "Unsupported audio extension",
    );
  });

  it("does not publish an asynchronous launch-file grant after renderer navigation", async () => {
    const file = await inputFile();
    const pending = files.enqueue(nativeWindow(win), file);
    win.webContents.emit("did-start-navigation", {}, applicationURL, false, true);
    await expect(pending).rejects.toThrow("expired");
    expect(await invoke("take", win)).toEqual([]);
    expect(win.webContents.send).not.toHaveBeenCalled();
  });
});

describe("batch directory capabilities", () => {
  it("bounds outstanding folder grants and restores capacity after release", async () => {
    const granted: Capability[] = [];
    for (let index = 0; index < 8; index++) granted.push(await selectDirectory());
    await expect(selectDirectory()).rejects.toThrow("Too many pending batch folders");
    await invoke("batch-release", win, granted[0].id);
    // A refused request must not open a dialog or consume its mocked result.
    electron.showOpenDialog.mockReset();
    expect(await selectDirectory()).toEqual({
      id: expect.any(String),
      name: path.basename(directory),
    });
  });

  it("rejects a late folder dialog result after renderer navigation", async () => {
    let resolve!: (result: unknown) => void;
    electron.showOpenDialog.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const pending = invoke("batch-directory", win);
    await Promise.resolve();
    win.webContents.emit("did-start-navigation", {}, applicationURL, false, true);
    resolve({ canceled: false, filePaths: [directory] });
    await expect(pending).rejects.toThrow("Batch folder request expired");
    expect(await selectDirectory()).toEqual({
      id: expect.any(String),
      name: path.basename(directory),
    });
  });

  it("allows fresh outputs, refuses existing files and symlinks, and enforces owner and release", async () => {
    const approved = await selectDirectory();
    await expect(invoke("batch-write", other, approved.id, "out.wav", bytes())).rejects.toThrow(
      "not authorized",
    );
    await invoke("batch-write", win, approved.id, "out.wav", bytes());
    expect(await readFile(path.join(directory, "out.wav"))).toEqual(Buffer.from([9, 8, 7]));
    await expect(
      invoke("batch-write", win, approved.id, "out.wav", new Uint8Array([1]).buffer),
    ).rejects.toThrow();
    const target = await inputFile();
    await symlink(target, path.join(directory, "link.wav"));
    await expect(invoke("batch-write", win, approved.id, "link.wav", bytes())).rejects.toThrow();
    expect(await readFile(target)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect((await readdir(directory)).some((name) => name.startsWith(".aae-batch-"))).toBe(false);
    await invoke("batch-release", win, approved.id);
    await expect(invoke("batch-write", win, approved.id, "next.wav", bytes())).rejects.toThrow(
      "not authorized",
    );
  });

  it.each([
    "../escape.wav",
    "nested/out.wav",
    "nested\\out.wav",
    "CON.wav",
    "out.exe",
    "out.wav.",
    "out.wav ",
    "bad\u0000.wav",
    "x".repeat(256),
  ])("rejects unsafe output name %j", async (name) => {
    const approved = await selectDirectory();
    await expect(invoke("batch-write", win, approved.id, name, bytes())).rejects.toThrow(
      "Invalid batch file output",
    );
    expect(await readdir(directory)).toEqual([]);
  });

  it("refuses a directory replaced after authorization", async () => {
    const destination = path.join(directory, "output");
    await mkdir(destination);
    const approved = await selectDirectory(destination);
    await rename(destination, path.join(directory, "old-output"));
    await mkdir(destination);
    await expect(invoke("batch-write", win, approved.id, "out.wav", bytes())).rejects.toThrow(
      "Batch folder changed",
    );
    expect(await readdir(destination)).toEqual([]);
  });

  it("revokes directory grants on main-frame navigation", async () => {
    const approved = await selectDirectory();
    win.webContents.emit("did-start-navigation", {}, applicationURL, false, true);
    await expect(invoke("batch-write", win, approved.id, "out.wav", bytes())).rejects.toThrow(
      "not authorized",
    );
  });
});
