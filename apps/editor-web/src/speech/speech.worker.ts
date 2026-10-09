/// <reference lib="webworker" />
/**
 * Speech worker: hosts speech.wasm (go-pocket-tts) off the main thread. It
 * fetches and verifies model files, keeps one model and its voices loaded and
 * returns synthesized PCM as a transferred buffer. It never touches documents.
 */
import type {
  SpeechCatalog,
  SpeechInitResult,
  SpeechLoaded,
  SpeechProgress,
  SpeechReply,
  SpeechRequest,
  SpeechSourceFile,
  SpeechSynthesisParams,
  SpeechSynthesisResult,
} from "./messages";
import { fetchVerified } from "./model-source";

declare const self: DedicatedWorkerGlobalScope;

interface GoRuntime {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
}

/** The surface packages/kernel/cmd/speech installs. */
interface SpeechBridge {
  sampleRate: number;
  catalog(): string;
  load(model: string, weights: Uint8Array, tokenizer: Uint8Array): Promise<void>;
  loadVoice(model: string, voice: string, data: Uint8Array): Promise<void>;
  synthesize(
    params: string,
    onProgress?: (chunk: number, chunks: number, step: number, maxSteps: number) => void,
  ): Promise<Uint8Array>;
  cancel(): void;
  unload(): Promise<void>;
  loaded(): string;
}

declare global {
  var Go: (new () => GoRuntime) | undefined;
  var AAESpeech: SpeechBridge | undefined;
  var __aaeSpeechReady: (() => void) | undefined;
}

let speech: SpeechBridge | undefined;
let catalog: SpeechCatalog | undefined;
/** Aborts the running ensure's downloads. */
let downloads: AbortController | undefined;

function post(msg: SpeechReply, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

async function boot(wasmUrl: string, wasmExecUrl: string): Promise<SpeechInitResult> {
  if (speech) throw new Error("speech worker already initialised");
  await import(/* @vite-ignore */ wasmExecUrl);
  if (!globalThis.Go) throw new Error(`${wasmExecUrl} did not define globalThis.Go`);
  const go = new globalThis.Go();
  const ready = new Promise<void>((resolve) => {
    globalThis.__aaeSpeechReady = resolve;
  });
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error(`fetch ${wasmUrl}: ${response.status} ${response.statusText}`);
  const { instance } = await WebAssembly.instantiateStreaming(response, go.importObject);
  // The Go program runs until the worker ends; an exit means it ran out of memory or crashed.
  go.run(instance).then(
    () => post({ kind: "fatal", error: "speech engine stopped" }),
    (err: unknown) => post({ kind: "fatal", error: `speech engine crashed: ${String(err)}` }),
  );
  await ready;
  speech = globalThis.AAESpeech;
  if (!speech) throw new Error("speech.wasm did not install globalThis.AAESpeech");
  catalog = JSON.parse(speech.catalog()) as SpeechCatalog;
  return { catalog, sampleRate: speech.sampleRate };
}

function requireSpeech(): SpeechBridge {
  if (!speech) throw new Error("speech worker not initialised");
  return speech;
}

function loaded(): SpeechLoaded {
  const state = JSON.parse(requireSpeech().loaded()) as Partial<SpeechLoaded>;
  return { model: state.model ?? "", voices: state.voices ?? [] };
}

async function ensure(
  id: number,
  model: string,
  voice: string,
  files: (SpeechSourceFile | undefined)[],
): Promise<SpeechLoaded> {
  const bridge = requireSpeech();
  const [weights, tokenizer, voiceFile] = files;
  if (downloads) throw new Error("another speech model download is running");
  const abort = new AbortController();
  downloads = abort;
  const progress = (value: SpeechProgress) => post({ kind: "progress", id, progress: value });
  const pending = files.filter((file): file is SpeechSourceFile => file !== undefined);
  const total = pending.reduce((sum, file) => sum + file.size, 0);
  let done = 0;
  const fetchOne = async (file: SpeechSourceFile) => {
    const before = done;
    const bytes = await fetchVerified(file, {
      signal: abort.signal,
      onProgress: (received) =>
        progress({ stage: "download", path: file.path, done: before + received, total }),
    });
    done = before + file.size;
    return bytes;
  };
  try {
    if (weights || tokenizer) {
      if (!weights || !tokenizer) throw new Error("a speech model needs weights and a tokenizer");
      // Release the previous model before downloading the next one: two models
      // do not fit the 4 GiB WASM address space together.
      if (loaded().model && loaded().model !== model) await bridge.unload();
      const weightBytes = await fetchOne(weights);
      const tokenizerBytes = await fetchOne(tokenizer);
      progress({ stage: "load" });
      await bridge.load(model, weightBytes, tokenizerBytes);
    }
    if (voiceFile) {
      const data = await fetchOne(voiceFile);
      progress({ stage: "load" });
      await bridge.loadVoice(model, voice, data);
    }
    const state = loaded();
    if (state.model !== model || !state.voices.includes(voice))
      throw new Error(`speech model ${model} with voice ${voice} is not loaded`);
    return state;
  } finally {
    if (downloads === abort) downloads = undefined;
  }
}

async function synthesize(
  id: number,
  params: SpeechSynthesisParams,
): Promise<{ result: SpeechSynthesisResult; transfer: Transferable[] }> {
  const bridge = requireSpeech();
  const bytes = await bridge.synthesize(JSON.stringify(params), (chunk, chunks, step, maxSteps) =>
    post({
      kind: "progress",
      id,
      progress: { stage: "synthesize", chunk, chunks, step, maxSteps },
    }),
  );
  // Go returns a fresh array over its own buffer; copy only if it is a subview.
  const pcm =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? (bytes.buffer as ArrayBuffer)
      : bytes.slice().buffer;
  return { result: { pcm, sampleRate: bridge.sampleRate }, transfer: [pcm] };
}

async function handle(req: SpeechRequest): Promise<{ result: unknown; transfer?: Transferable[] }> {
  switch (req.op) {
    case "init":
      return { result: await boot(req.wasmUrl, req.wasmExecUrl) };
    case "ensure":
      return {
        result: await ensure(req.id, req.model, req.voice, [
          req.weights,
          req.tokenizer,
          req.voiceFile,
        ]),
      };
    case "synthesize":
      return synthesize(req.id, req.params);
    case "cancel":
      downloads?.abort();
      speech?.cancel();
      return { result: undefined };
    case "unload":
      await requireSpeech().unload();
      return { result: undefined };
  }
}

self.addEventListener("message", (event: MessageEvent<SpeechRequest>) => {
  const { id } = event.data;
  handle(event.data).then(
    ({ result, transfer }) => post({ kind: "reply", id, ok: true, result }, transfer),
    (err: unknown) =>
      post({
        kind: "reply",
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
  );
});
