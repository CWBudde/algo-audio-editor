import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpeechModelFile } from "../../editor-web/src/platform";
import { parseSpeechCatalog, parseSpeechModelFiles } from "./speech-model-paths";
import { catalogFile, registerSpeechModels, SPEECH_MODELS_URL } from "./speech-models";

type Route =
  | { redirect: string }
  | { status?: number; headers?: Record<string, string>; chunks: Buffer[]; hang?: boolean };

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  windows: new Map<unknown, unknown>(),
  userData: "",
  routes: new Map<string, unknown>(),
  requests: [] as { url: string; options: Record<string, unknown> }[],
}));

/** Mimics Electron's ClientRequest: manual redirects continue only on followRedirect(). */
function fakeRequest(options: Record<string, unknown>) {
  const req = Object.assign(new EventEmitter(), {
    aborted: false,
    follow: false,
    body: undefined as Readable | undefined,
    followRedirect: () => {
      req.follow = true;
    },
    abort: () => {
      if (req.aborted) return;
      req.aborted = true;
      req.body?.destroy();
      req.emit("abort");
    },
    end: () => {
      queueMicrotask(() => run(options.url as string));
    },
  });
  const run = (url: string) => {
    if (req.aborted) return;
    electron.requests.push({ url, options });
    const route = electron.routes.get(url) as Route | undefined;
    if (!route) {
      req.emit("error", new Error(`net::ERR_NAME_NOT_RESOLVED ${url}`));
      return;
    }
    if ("redirect" in route) {
      req.follow = false;
      req.emit("redirect", 302, "GET", route.redirect, {});
      if (req.follow) queueMicrotask(() => run(route.redirect));
      else if (!req.aborted) req.emit("error", new Error("Redirect was cancelled"));
      return;
    }
    // Like Electron's IncomingMessage: a push stream that a request abort destroys.
    const body = new Readable({ read() {} });
    const pending = [...route.chunks];
    const pushNext = () => {
      if (body.destroyed) return;
      const chunk = pending.shift();
      if (chunk) {
        body.push(chunk);
        setTimeout(pushNext, 1);
      } else if (!("hang" in route && route.hang)) body.push(null);
    };
    setTimeout(pushNext, 1);
    req.body = body;
    req.emit(
      "response",
      Object.assign(req.body, { statusCode: route.status ?? 200, headers: route.headers ?? {} }),
    );
  };
  return req;
}

vi.mock("electron", () => ({
  app: { getPath: () => electron.userData },
  BrowserWindow: { fromWebContents: (sender: unknown) => electron.windows.get(sender) },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      electron.handlers.set(name, handler),
  },
  net: { request: fakeRequest },
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
const invoke = <T = unknown>(name: string, owner: TestWindow, ...args: unknown[]): Promise<T> =>
  Promise.resolve().then(
    () =>
      electron.handlers.get(`speech-models.${name}`)?.(
        { sender: owner.webContents, senderFrame: owner.webContents.mainFrame },
        ...args,
      ) as T,
  );

const REVISION = "d4fdd22ae8c8e1cb3634e150ebeff1dab2d16df3";
const hubURL = (file: string) =>
  `https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/${REVISION}/${file}`;
const CDN = "https://us.aws.cdn.hf.co/xet-bridge-us/0123/abcdef";
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const payload = (size: number, seed = 1) =>
  Buffer.from(Array.from({ length: size }, (_, index) => (index * 31 + seed) & 0xff));
/** The shipped catalog as the tests see it: every file model() creates is pinned. */
const pinned = new Map<string, SpeechModelFile>();
const model = (data: Buffer, file = "german/voices/juergen.safetensors"): SpeechModelFile => {
  const entry = {
    url: hubURL(path.basename(file)),
    sha256: sha256(data),
    size: data.length,
    path: file,
  };
  pinned.set(file, entry);
  return entry;
};
const serve = (
  url: string,
  data: Buffer,
  extra: Partial<Exclude<Route, { redirect: string }>> = {},
) =>
  electron.routes.set(url, {
    chunks: [data.subarray(0, 3), data.subarray(3)],
    headers: { "content-length": String(data.length) },
    ...extra,
  });

let userData: string;
let root: string;
let win: TestWindow;
let other: TestWindow;
let speech: ReturnType<typeof registerSpeechModels>;

/** Every file below the speech model root, as slash-separated relative paths. */
const tree = async (directory = root, prefix = ""): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory())
      files.push(...(await tree(path.join(directory, entry.name), `${relative}/`)));
    else files.push(relative);
  }
  return files.sort();
};
const until = async (condition: () => boolean | Promise<boolean>) => {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("condition not reached");
};

beforeEach(async () => {
  userData = await mkdtemp(path.join(os.tmpdir(), "aae-speech-unit-"));
  root = path.join(userData, "speech-models");
  electron.userData = userData;
  electron.handlers.clear();
  electron.windows.clear();
  electron.routes.clear();
  electron.requests.length = 0;
  win = createWindow(1);
  other = createWindow(2);
  speech = registerSpeechModels(applicationURL, async () => pinned);
  speech.attach(win as unknown as BrowserWindow);
  speech.attach(other as unknown as BrowserWindow);
});
afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe("speech model request validation", () => {
  const data = payload(16);
  const valid = model(data);
  it("accepts every catalog file shape", () => {
    const files = [
      valid,
      {
        ...valid,
        path: "english_2026-01/model.safetensors",
        url: hubURL("tts_b6369a24.safetensors"),
      },
      { ...valid, path: "english_2026-01/tokenizer.model", url: hubURL("tokenizer.model") },
      { ...valid, path: "english_2026-09/tokenizer.json", url: hubURL("embeddings/a.safetensors") },
    ];
    expect(parseSpeechModelFiles(files)).toEqual(files);
  });

  it.each<[string, unknown]>([
    ["not a list", valid],
    ["an empty list", []],
    [
      "too many files",
      Array.from({ length: 41 }, (_, i) => ({ ...valid, path: `m/v${i}.safetensors` })),
    ],
    ["a null entry", [null]],
    ["http", [{ ...valid, url: valid.url.replace("https:", "http:") }]],
    ["a foreign host", [{ ...valid, url: valid.url.replace("huggingface.co", "evil.example") }]],
    [
      "a look-alike host",
      [{ ...valid, url: valid.url.replace("huggingface.co", "huggingface.co.evil.example") }],
    ],
    [
      "a CDN host as source",
      [{ ...valid, url: valid.url.replace("huggingface.co", "cdn-lfs.hf.co") }],
    ],
    ["credentials", [{ ...valid, url: valid.url.replace("https://", "https://user@") }]],
    ["a port", [{ ...valid, url: valid.url.replace("huggingface.co", "huggingface.co:8443") }]],
    ["a query", [{ ...valid, url: `${valid.url}?download=true` }]],
    ["a branch instead of a revision", [{ ...valid, url: valid.url.replace(REVISION, "main") }]],
    [
      "an upper-case revision",
      [{ ...valid, url: valid.url.replace(REVISION, REVISION.toUpperCase()) }],
    ],
    ["a blob URL", [{ ...valid, url: valid.url.replace("/resolve/", "/blob/") }]],
    ["URL dot segments", [{ ...valid, url: valid.url.replace("/juergen", "/../juergen") }]],
    ["URL escapes", [{ ...valid, url: valid.url.replace("juergen", "%2e%2e") }]],
    ["a short sha256", [{ ...valid, sha256: valid.sha256.slice(1) }]],
    ["an upper-case sha256", [{ ...valid, sha256: valid.sha256.toUpperCase() }]],
    ["a zero size", [{ ...valid, size: 0 }]],
    ["a fractional size", [{ ...valid, size: 1.5 }]],
    ["a string size", [{ ...valid, size: "16" }]],
    ["more than 4 GiB", [{ ...valid, size: 4 * 1024 ** 3 + 1 }]],
    ["path traversal", [{ ...valid, path: "../escape.safetensors" }]],
    ["a nested traversal", [{ ...valid, path: "german/../../escape.safetensors" }]],
    ["an absolute path", [{ ...valid, path: "/etc/model.safetensors" }]],
    ["a backslash", [{ ...valid, path: "german\\voices\\juergen.safetensors" }]],
    ["an empty segment", [{ ...valid, path: "german//juergen.safetensors" }]],
    ["a dot segment", [{ ...valid, path: "german/./juergen.safetensors" }]],
    ["a hidden segment", [{ ...valid, path: ".cache/juergen.safetensors" }]],
    ["a Windows device name", [{ ...valid, path: "german/con.safetensors" }]],
    ["a trailing dot", [{ ...valid, path: "german./juergen.safetensors" }]],
    ["too many segments", [{ ...valid, path: "a/b/c/d/e/f/g.safetensors" }]],
    ["an unexpected extension", [{ ...valid, path: "german/voices/juergen.exe" }]],
    ["a part file", [{ ...valid, path: `german/x.safetensors.${"0".repeat(36)}.part` }]],
    ["a duplicate path", [valid, { ...valid }]],
    ["a case-insensitive duplicate path", [valid, { ...valid, path: valid.path.toUpperCase() }]],
  ])("rejects %s", (_name, input) => {
    expect(() => parseSpeechModelFiles(input)).toThrow("Invalid speech model request");
  });

  it("rejects invalid requests and untrusted senders before any network access", async () => {
    await expect(
      invoke("ensure", win, [{ ...valid, url: "https://evil.example/x" }]),
    ).rejects.toThrow("Invalid speech model request");
    const handler = electron.handlers.get("speech-models.ensure");
    await expect(
      Promise.resolve().then(() =>
        handler?.({ sender: win.webContents, senderFrame: { url: applicationURL } }, [valid]),
      ),
    ).rejects.toThrow("Untrusted IPC sender");
    win.webContents.mainFrame.url = "https://example.com/";
    for (const name of ["ensure", "cancel", "remove", "usage"])
      await expect(invoke(name, win, [valid])).rejects.toThrow("Untrusted IPC origin");
    expect(electron.requests).toEqual([]);
  });
});

describe("speech model catalog", () => {
  it("refuses files that are not exactly the shipped catalog's before any network access", async () => {
    const data = payload(16);
    const valid = model(data, "german/voices/anna.safetensors");
    for (const request of [
      { ...valid, path: "german/voices/unknown.safetensors" },
      { ...valid, sha256: sha256(payload(16, 9)) },
      { ...valid, size: 17 },
      { ...valid, url: hubURL("other.safetensors") },
    ])
      await expect(invoke("ensure", win, [request])).rejects.toThrow(
        "is not in the speech model catalog",
      );
    expect(electron.requests).toEqual([]);
  });

  it("indexes the go-pocket-tts catalog JSON by path", () => {
    const weights = model(payload(8), "german/model.safetensors");
    const tokenizer = model(payload(4), "german/tokenizer.json");
    const voice = model(payload(2), "german/voices/juergen.safetensors");
    const json = JSON.stringify({
      default: "german",
      models: [{ name: "german", weights, tokenizer, voices: [{ id: "juergen", ...voice }] }],
    });
    expect([...parseSpeechCatalog(json).values()]).toEqual([weights, tokenizer, voice]);
    expect(() => parseSpeechCatalog("{}")).toThrow("Invalid speech model catalog");
    expect(() =>
      parseSpeechCatalog(
        JSON.stringify({
          models: [
            { weights: { ...weights, url: "https://evil.example/" }, tokenizer, voices: [] },
          ],
        }),
      ),
    ).toThrow("Invalid speech model request");
  });

  // Vitest runs in apps/desktop; the file exists after scripts/build-wasm.mjs.
  const shipped = path.resolve("..", "editor-web", "public", "speech-catalog.json");
  it.skipIf(!existsSync(shipped))("accepts the catalog the web build ships", async () => {
    const files = parseSpeechCatalog(await readFile(shipped, "utf8"));
    expect(files.size).toBeGreaterThan(6);
    expect(files.get("german/model.safetensors")?.url).toMatch(/^https:\/\/huggingface\.co\//);
  });

  it("reports a missing catalog and reads it once it exists", async () => {
    const file = path.join(userData, "speech-catalog.json");
    const load = catalogFile(file);
    await expect(load()).rejects.toThrow("Speech model catalog unavailable");
    const weights = model(payload(8), "german/model.safetensors");
    const tokenizer = model(payload(4), "german/tokenizer.json");
    await writeFile(file, JSON.stringify({ models: [{ weights, tokenizer, voices: [] }] }));
    expect((await load()).get(weights.path)).toEqual(weights);
  });
});

describe("speech model downloads", () => {
  it("follows an allowed CDN redirect, writes the verified file atomically and reports progress", async () => {
    const weights = payload(64, 3);
    const tokenizer = payload(8, 5);
    const files = [
      model(weights, "german/model.safetensors"),
      model(tokenizer, "german/tokenizer.model"),
    ];
    electron.routes.set(files[0].url, { redirect: CDN });
    serve(CDN, weights);
    serve(files[1].url, tokenizer);
    await expect(invoke("ensure", win, files)).resolves.toBe(SPEECH_MODELS_URL);
    expect(SPEECH_MODELS_URL).toBe("app://editor/speech-models/");
    expect(await readFile(path.join(root, "german", "model.safetensors"))).toEqual(weights);
    expect(await readFile(path.join(root, "german", "tokenizer.model"))).toEqual(tokenizer);
    expect(await tree()).toEqual(["german/model.safetensors", "german/tokenizer.model"]);
    expect(electron.requests.map((request) => request.url)).toEqual([
      files[0].url,
      CDN,
      files[1].url,
    ]);
    expect(electron.requests[0].options).toMatchObject({
      redirect: "manual",
      credentials: "omit",
      useSessionCookies: false,
      cache: "no-store",
    });
    const progress = win.webContents.send.mock.calls.map(([channel, value]) => {
      expect(channel).toBe("speech-models.progress");
      return value;
    });
    expect(progress.at(-1)).toEqual({ path: "german/tokenizer.model", done: 72, total: 72 });
    expect(progress).toContainEqual({ path: "german/model.safetensors", done: 64, total: 72 });
    expect(other.webContents.send).not.toHaveBeenCalled();
  });

  it("does not download verified files again, but replaces corrupt ones", async () => {
    const data = payload(32);
    const file = model(data);
    serve(file.url, data);
    await invoke("ensure", win, [file]);
    await invoke("ensure", win, [file]);
    expect(electron.requests).toHaveLength(1);
    expect(win.webContents.send).toHaveBeenLastCalledWith("speech-models.progress", {
      path: file.path,
      done: 32,
      total: 32,
    });
    // Same size, different bytes: the stored hash cache must not hide the change.
    await writeFile(path.join(root, ...file.path.split("/")), payload(32, 9));
    await invoke("ensure", win, [file]);
    expect(electron.requests).toHaveLength(2);
    expect(await readFile(path.join(root, ...file.path.split("/")))).toEqual(data);
  });

  it("replaces a planted symlink instead of following it", async () => {
    const data = payload(16);
    const file = model(data);
    const outside = path.join(userData, "outside.safetensors");
    await writeFile(outside, data);
    await mkdir(path.join(root, "german", "voices"), { recursive: true });
    await symlink(outside, path.join(root, ...file.path.split("/")));
    serve(file.url, data);
    await invoke("ensure", win, [file]);
    expect(electron.requests).toHaveLength(1);
    expect(await readFile(outside)).toEqual(data);
    expect(await tree()).toEqual([file.path]);
  });

  it("refuses a symlinked model folder instead of writing through it", async () => {
    const data = payload(16);
    const file = model(data);
    const outside = path.join(userData, "outside");
    await mkdir(outside);
    await mkdir(root, { recursive: true });
    await symlink(outside, path.join(root, "german"), "dir");
    serve(file.url, data);
    await expect(invoke("ensure", win, [file])).rejects.toThrow("not a plain directory");
    expect(electron.requests).toEqual([]);
    expect(await readdir(outside)).toEqual([]);
  });

  it("removes stale partial files left by an interrupted run", async () => {
    const data = payload(16);
    const file = model(data);
    const stale = `${file.path}.0b0c4f2e-6d4c-4c47-9a39-0d5a2c9f8e11.part`;
    await mkdir(path.join(root, "german", "voices"), { recursive: true });
    await writeFile(path.join(root, ...stale.split("/")), "partial");
    serve(file.url, data);
    await invoke("ensure", win, [file]);
    expect(await tree()).toEqual([file.path]);
  });

  it.each<[string, (data: Buffer, file: SpeechModelFile) => void, string]>([
    [
      "a checksum mismatch",
      (data, file) => serve(file.url, Buffer.from(data).fill(0)),
      "Checksum mismatch",
    ],
    [
      "too many bytes",
      (data, file) => serve(file.url, Buffer.concat([data, Buffer.from([1])]), { headers: {} }),
      "larger than expected",
    ],
    [
      "too few bytes",
      (data, file) => serve(file.url, data.subarray(0, data.length - 1), { headers: {} }),
      "incomplete",
    ],
    [
      "a wrong Content-Length",
      (data, file) => serve(file.url, data, { headers: { "content-length": "1" } }),
      "Unexpected download size",
    ],
    ["an HTTP error", (data, file) => serve(file.url, data, { status: 404 }), "HTTP 404"],
    [
      "a redirect to a foreign host",
      (data, file) => {
        electron.routes.set(file.url, { redirect: "https://evil.example/model" });
        serve("https://evil.example/model", data);
      },
      "unexpected host",
    ],
    [
      "a redirect to plain http",
      (data, file) => {
        electron.routes.set(file.url, { redirect: "http://us.aws.cdn.hf.co/model" });
        serve("http://us.aws.cdn.hf.co/model", data);
      },
      "unexpected host",
    ],
    [
      "a redirect loop",
      (_data, file) => {
        electron.routes.set(file.url, { redirect: `${CDN}/1` });
        for (let hop = 1; hop <= 6; hop++)
          electron.routes.set(`${CDN}/${hop}`, { redirect: `${CDN}/${hop + 1}` });
      },
      "Too many redirects",
    ],
  ])(
    "rejects %s and leaves neither the file nor a partial file",
    async (_name, arrange, message) => {
      const data = payload(24);
      const file = model(data);
      arrange(data, file);
      await expect(invoke("ensure", win, [file])).rejects.toThrow(message);
      expect(await tree()).toEqual([]);
      expect(electron.requests.some((request) => request.url.startsWith("https://evil"))).toBe(
        false,
      );
      expect(electron.requests.some((request) => request.url.startsWith("http:"))).toBe(false);
    },
  );

  const startHangingDownload = async (owner = win) => {
    const data = payload(4096);
    const file = model(data);
    serve(file.url, data, { chunks: [data.subarray(0, 100)], hang: true });
    const pending = invoke<string>("ensure", owner, [file]);
    pending.catch(() => {});
    await until(async () => owner.webContents.send.mock.calls.length > 0);
    expect((await tree()).some((entry) => entry.endsWith(".part"))).toBe(true);
    return { pending, file, data };
  };

  it("rejects concurrent work, then cancels with 'cancelled' and cleans up", async () => {
    const { pending, file } = await startHangingDownload();
    await expect(invoke("ensure", win, [file])).rejects.toThrow("already running");
    await expect(invoke("remove", win)).rejects.toThrow("while a download is running");
    // Another window cannot cancel this window's download.
    await invoke("cancel", other);
    expect(
      await Promise.race([
        pending.then(() => "settled"),
        new Promise((r) => setTimeout(() => r("pending"), 20)),
      ]),
    ).toBe("pending");
    await invoke("cancel", win);
    await expect(pending).rejects.toThrow(/^cancelled$/);
    expect(await tree()).toEqual([]);
    // The next ensure starts fresh.
    const data = payload(8);
    const next = model(data, "german/tokenizer.model");
    serve(next.url, data);
    await expect(invoke("ensure", win, [next])).resolves.toBe(SPEECH_MODELS_URL);
  });

  it.each(["navigation", "close"])(
    "aborts the requesting window's download on %s",
    async (kind) => {
      const { pending } = await startHangingDownload();
      if (kind === "navigation")
        win.webContents.emit("did-start-navigation", {}, applicationURL, false, true);
      else win.emit("closed");
      await expect(pending).rejects.toThrow(/^cancelled$/);
      expect(await tree()).toEqual([]);
    },
  );

  it("keeps the download through subframe navigation and other windows closing", async () => {
    const { pending } = await startHangingDownload();
    win.webContents.emit("did-start-navigation", {}, "https://example.com/", false, false);
    other.emit("closed");
    expect(
      await Promise.race([
        pending.then(() => "settled"),
        new Promise((r) => setTimeout(() => r("pending"), 20)),
      ]),
    ).toBe("pending");
    await invoke("cancel", win);
    await expect(pending).rejects.toThrow("cancelled");
  });

  it("reports usage and removes every downloaded model", async () => {
    expect(await invoke("usage", win)).toBe(0);
    await invoke("remove", win);
    const weights = payload(40);
    const voice = payload(9);
    const files = [model(weights, "english_2026-01/model.safetensors"), model(voice)];
    serve(files[0].url, weights);
    serve(files[1].url, voice);
    await invoke("ensure", win, files);
    expect(await invoke("usage", win)).toBe(49);
    await invoke("remove", win);
    expect(await invoke("usage", win)).toBe(0);
    await expect(readdir(root)).rejects.toThrow();
    // Removal also drops cached verification: the next ensure downloads again.
    await invoke("ensure", win, files);
    expect(electron.requests).toHaveLength(4);
  });
});
