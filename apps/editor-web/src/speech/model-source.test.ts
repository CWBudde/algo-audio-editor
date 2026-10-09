import { describe, expect, it, vi } from "vitest";
import type { DesktopBridge, SpeechDownloadProgress } from "@/platform";
import { TEST_SPEECH_CATALOG } from "./catalog-fixture";
import type { SpeechSourceFile } from "./messages";
import {
  desktopSpeechUrl,
  fetchVerified,
  missingSpeechFiles,
  resolveSpeechSources,
  speechFileList,
  speechModelBytes,
} from "./model-source";

async function sha256(bytes: Uint8Array<ArrayBuffer>) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function streamed(chunks: Uint8Array[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  );
}

describe("missingSpeechFiles", () => {
  it("needs weights, tokenizer and voice for an unloaded model, then only new voices", () => {
    const all = missingSpeechFiles(TEST_SPEECH_CATALOG, "english_2026-01", "alba");
    expect(speechFileList(all).map((file) => file.path)).toEqual([
      "english_2026-01/model.safetensors",
      "english_2026-01/tokenizer.model",
      "english_2026-01/voices/alba.safetensors",
    ]);
    expect(all.voiceFile).not.toHaveProperty("id");
    const loaded = { model: "english_2026-01", voices: ["alba"] };
    expect(missingSpeechFiles(TEST_SPEECH_CATALOG, "english_2026-01", "alba", loaded)).toEqual({});
    expect(
      speechFileList(
        missingSpeechFiles(TEST_SPEECH_CATALOG, "english_2026-01", "marius", loaded),
      ).map((file) => file.path),
    ).toEqual(["english_2026-01/voices/marius.safetensors"]);
    // Another model replaces the loaded one, so its files are all needed.
    expect(
      speechFileList(missingSpeechFiles(TEST_SPEECH_CATALOG, "german_24l", "juergen", loaded)),
    ).toHaveLength(3);
  });
  it("rejects unknown models and voices", () => {
    expect(() => missingSpeechFiles(TEST_SPEECH_CATALOG, "klingon", "alba")).toThrow(/Unknown/);
    expect(() => missingSpeechFiles(TEST_SPEECH_CATALOG, "german_24l", "alba")).toThrow(
      /no voice alba/,
    );
  });
  it("sizes a model download as weights plus tokenizer", () => {
    expect(speechModelBytes(TEST_SPEECH_CATALOG.models[1])).toBe(4024);
  });
});

describe("resolveSpeechSources", () => {
  const files = missingSpeechFiles(TEST_SPEECH_CATALOG, "english_2026-01", "alba");
  it("fetches the pinned catalog URLs directly on the web", async () => {
    const sources = await resolveSpeechSources(files);
    expect(sources.weights?.source).toBe(files.weights?.url);
    expect(sources.voiceFile?.source).toBe(files.voiceFile?.url);
  });
  it("lets the desktop main process download and reads the files from app://", async () => {
    let listener: ((progress: SpeechDownloadProgress) => void) | undefined;
    const unsubscribe = vi.fn();
    const bridge = {
      ensureSpeechModels: vi.fn(async () => {
        listener?.({ path: "english_2026-01/model.safetensors", done: 10, total: 1040 });
        return "app://editor/speech-models/";
      }),
      onSpeechModelsProgress: vi.fn((callback) => {
        listener = callback;
        return unsubscribe;
      }),
      cancelSpeechModels: vi.fn(async () => {}),
    } as unknown as DesktopBridge;
    const onProgress = vi.fn();
    const sources = await resolveSpeechSources(files, { bridge, onProgress });
    expect(bridge.ensureSpeechModels).toHaveBeenCalledWith(speechFileList(files));
    expect(onProgress).toHaveBeenCalledWith({
      path: "english_2026-01/model.safetensors",
      done: 10,
      total: 1040,
    });
    expect(unsubscribe).toHaveBeenCalled();
    expect(sources.weights?.source).toBe(
      "app://editor/speech-models/english_2026-01/model.safetensors",
    );
    expect(sources.weights?.sha256).toBe(files.weights?.sha256);
    expect(bridge.cancelSpeechModels).not.toHaveBeenCalled();
  });
  it("cancels the desktop download when the signal aborts", async () => {
    const abort = new AbortController();
    const bridge = {
      ensureSpeechModels: vi.fn(
        () =>
          new Promise<string>((_resolve, reject) => {
            setTimeout(() => reject(new Error("cancelled")), 0);
          }),
      ),
      cancelSpeechModels: vi.fn(async () => {}),
    } as unknown as DesktopBridge;
    const pending = resolveSpeechSources(files, { bridge, signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(bridge.cancelSpeechModels).toHaveBeenCalled();
  });
  it("encodes each path segment below the desktop base", () => {
    expect(desktopSpeechUrl("app://editor/speech-models", "a b/c#d.bin")).toBe(
      "app://editor/speech-models/a%20b/c%23d.bin",
    );
  });
});

describe("fetchVerified", () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const file = async (change: Partial<SpeechSourceFile> = {}): Promise<SpeechSourceFile> => ({
    url: "https://huggingface.co/x/resolve/rev/model.safetensors",
    source: "https://huggingface.co/x/resolve/rev/model.safetensors",
    path: "x/model.safetensors",
    size: bytes.byteLength,
    sha256: await sha256(bytes),
    ...change,
  });
  it("returns streamed bytes with progress when size and SHA-256 match", async () => {
    const fetch = vi.fn(async () => streamed([bytes.slice(0, 3), bytes.slice(3)]));
    const onProgress = vi.fn();
    const result = await fetchVerified(await file(), { fetch, onProgress });
    expect([...result]).toEqual([...bytes]);
    expect(onProgress.mock.calls).toEqual([[3], [8]]);
    expect(fetch).toHaveBeenCalledWith(
      "https://huggingface.co/x/resolve/rev/model.safetensors",
      expect.anything(),
    );
  });
  it("never returns a file whose checksum or size differs", async () => {
    const fetch = vi.fn(async () => streamed([bytes]));
    await expect(fetchVerified(await file({ sha256: "f".repeat(64) }), { fetch })).rejects.toThrow(
      /does not match the pinned catalog/,
    );
    await expect(fetchVerified(await file({ size: 7 }), { fetch })).rejects.toThrow(
      /does not match/,
    );
    await expect(fetchVerified(await file({ size: 9 }), { fetch })).rejects.toThrow(
      /does not match/,
    );
  });
  it("reports HTTP failures", async () => {
    const fetch = vi.fn(async () => new Response("gone", { status: 404, statusText: "Not Found" }));
    await expect(fetchVerified(await file(), { fetch })).rejects.toThrow(/404 Not Found/);
  });
});
