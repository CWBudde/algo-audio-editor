import type { DocumentInfoResult, EditResult, ProcessJobResult } from "@aae/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { KernelClient } from "@/kernel/client";
import { TEST_SPEECH_CATALOG } from "@/speech/catalog-fixture";
import type { SpeechLoaded } from "@/speech/messages";
import { type SpeechEngine, type SpeechOptions, type SpeechRuntime, useSpeech } from "./use-speech";

const info: DocumentInfoResult = {
  documentId: "doc-1",
  name: "voice.wav",
  sampleRate: 48000,
  channels: 2,
  frames: 1000,
  bitDepth: 32,
  float: true,
};
const cursor = { start: 100, end: 100, channelMask: 3 };
const result = { document: { ...info, documentId: "doc-2", frames: 1096 } } as EditResult;
const running: ProcessJobResult = {
  candidate: { sampleRate: 48000, channels: 2, frames: 1096, start: 100, end: 196, channelMask: 3 },
  documentId: info.documentId,
  ...cursor,
  jobId: "speech-1",
  operation: "generate",
  state: "running",
  phase: "processing",
  phaseIndex: 0,
  phaseCount: 1,
  gainResolved: true,
  gainDb: 0,
  processedFrames: 0,
  totalFrames: 96,
  planningSteps: 0,
  inputPeak: 0,
  inputLufs: null,
  predictedLufs: null,
  outputLufs: null,
  peak: 0,
  nonFinite: false,
};

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup(overrides: { engine?: Partial<SpeechEngine>; start?: SpeechRuntime["start"] } = {}) {
  let loaded: SpeechLoaded = { model: "", voices: [] };
  let jobs = 0;
  const engine: SpeechEngine = {
    catalog: TEST_SPEECH_CATALOG,
    loaded: () => loaded,
    ensureModel: vi.fn(async (model: string, voice: string, onProgress) => {
      onProgress?.({ stage: "download", path: "x", done: 5, total: 10 });
      loaded = { model, voices: [voice] };
    }),
    synthesize: vi.fn(async (_params, onProgress) => {
      onProgress?.({ stage: "synthesize", chunk: 1, chunks: 1, step: 1, maxSteps: 4 });
      return { pcm: new Float32Array([0.25, -0.25]).buffer, sampleRate: 24000 };
    }),
    ...overrides.engine,
  } as SpeechEngine;
  const release = vi.fn();
  const runtime: SpeechRuntime = {
    start: overrides.start ?? vi.fn(async () => engine),
    hold: vi.fn(() => release),
  };
  const startAudioProcess = vi.fn(async () => ({ ...running, jobId: `speech-${++jobs}` }));
  const call = vi.fn(async (method: string, params?: { jobId?: string }) => {
    if (method === "process.cancel")
      return { ...running, jobId: params?.jobId, state: "cancelled" };
    if (method === "process.commit") return result;
    throw new Error(`Unexpected ${method}`);
  });
  const runProcess = vi.fn(async (params: { jobId: string }) => ({
    ...running,
    jobId: params.jobId,
    state: "ready" as const,
    processedFrames: 96,
    peak: 0.25,
  }));
  const options: SpeechOptions = {
    client: { call, runProcess, startAudioProcess } as unknown as KernelClient,
    info,
    withOperation: vi.fn(async (work) => work()),
    beforeEdit: vi.fn().mockResolvedValue(undefined),
    preparePreview: vi.fn().mockResolvedValue(undefined),
    playPreview: vi.fn().mockResolvedValue(undefined),
    stopPreview: vi.fn().mockResolvedValue(undefined),
    onEdited: vi.fn(),
    onRecorded: vi.fn(),
    runtime,
  };
  const hook = renderHook((props: SpeechOptions) => useSpeech(props), { initialProps: options });
  return { ...hook, options, engine, runtime, release, call, runProcess, startAudioProcess };
}

async function opened(s: ReturnType<typeof setup>) {
  act(() => s.result.current.open(cursor));
  await waitFor(() => expect(s.result.current.view?.engine.status).toBe("ready"));
}

afterEach(cleanup);

it("opens with the catalog defaults and holds the speech worker while open", async () => {
  const s = setup();
  await opened(s);
  expect(s.runtime.hold).toHaveBeenCalledTimes(1);
  expect(s.result.current.view?.form).toMatchObject({
    model: "english_2026-01",
    voice: "alba",
    text: "Hello world.",
  });
  expect(s.result.current.view?.current).toBe(false);
  await act(async () => s.result.current.cancel());
  expect(s.result.current.view).toBeUndefined();
  expect(s.release).toHaveBeenCalledTimes(1);
});

it("generates speech into a ready candidate, previews it and applies one recorded edit", async () => {
  const s = setup();
  await opened(s);
  act(() => s.result.current.setForm({ seedText: "77", levelText: "-6" }));
  await act(async () => s.result.current.generate());
  expect(s.engine.ensureModel).toHaveBeenCalledWith(
    "english_2026-01",
    "alba",
    expect.any(Function),
    expect.any(AbortSignal),
  );
  expect(s.engine.synthesize).toHaveBeenCalledWith(
    {
      model: "english_2026-01",
      voice: "alba",
      text: "Hello world.",
      temperature: 0.3,
      samplerSteps: 1,
      eosThreshold: -4,
      seed: 77,
    },
    expect.any(Function),
    expect.any(AbortSignal),
  );
  expect(s.startAudioProcess).toHaveBeenCalledWith(
    {
      documentId: "doc-1",
      ...cursor,
      operation: "generate",
      generator: "audio",
      sourceSampleRate: 24000,
      levelDb: -6,
    },
    expect.any(ArrayBuffer),
  );
  expect(s.result.current.view).toMatchObject({ phase: "ready", current: true });
  expect(s.result.current.view?.activity).toBeUndefined();
  expect(s.result.current.view?.engine).toMatchObject({
    loaded: { model: "english_2026-01", voices: ["alba"] },
  });

  await act(async () => s.result.current.preview());
  expect(s.options.playPreview).toHaveBeenCalledWith(
    info,
    expect.objectContaining({ jobId: "speech-1" }),
  );
  expect(s.result.current.view?.previewing).toBe(true);
  await act(async () => s.result.current.apply());
  // Preview and Apply reuse the generated candidate.
  expect(s.startAudioProcess).toHaveBeenCalledTimes(1);
  expect(s.call).toHaveBeenCalledWith("process.commit", { documentId: "doc-1", jobId: "speech-1" });
  expect(s.options.onEdited).toHaveBeenCalledWith(result, "doc-1");
  expect(s.options.onRecorded).toHaveBeenCalledWith(
    {
      method: "speech.generate",
      params: {
        documentId: "doc-1",
        ...cursor,
        model: "english_2026-01",
        voice: "alba",
        text: "Hello world.",
        temperature: 0.3,
        samplerSteps: 1,
        eosThreshold: -4,
        seed: 77,
        levelDb: -6,
      },
    },
    info,
  );
  expect(s.result.current.view).toBeUndefined();
});

it("invalidates the candidate when the text or seed changes", async () => {
  const s = setup();
  await opened(s);
  await act(async () => s.result.current.generate());
  expect(s.result.current.view?.current).toBe(true);
  act(() => s.result.current.setForm({ text: "Something else." }));
  expect(s.result.current.view?.current).toBe(false);
  act(() => s.result.current.setForm({ text: "Hello world." }));
  expect(s.result.current.view?.current).toBe(true);
  vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
    (array as Uint32Array)[0] = 123456;
    return array;
  });
  act(() => s.result.current.newSeed());
  expect(s.result.current.view?.form.seedText).toBe("123456");
  expect(s.result.current.view?.current).toBe(false);
  await act(async () => s.result.current.generate());
  expect(s.startAudioProcess).toHaveBeenCalledTimes(2);
  expect(s.result.current.view?.current).toBe(true);
  // The old candidate is discarded before the new one starts.
  expect(s.call).toHaveBeenCalledWith("process.cancel", { documentId: "doc-1", jobId: "speech-1" });
});

it("Cancel aborts a running synthesis without reporting it or starting a kernel job", async () => {
  const synthesis = deferred<never>();
  const s = setup({
    engine: {
      synthesize: vi.fn((_params, progress, signal?: AbortSignal) => {
        progress?.({ stage: "synthesize", chunk: 1, chunks: 3, step: 0, maxSteps: 8 });
        signal?.addEventListener("abort", () =>
          synthesis.reject(new DOMException("Speech generation cancelled", "AbortError")),
        );
        return synthesis.promise;
      }),
    },
  });
  await opened(s);
  act(() => {
    void s.result.current.generate();
  });
  await waitFor(() => expect(s.result.current.view?.activity?.stage).toBe("synthesize"));
  await act(async () => s.result.current.cancel());
  expect(s.result.current.view).toBeUndefined();
  expect(s.startAudioProcess).not.toHaveBeenCalled();
});

it("shows failures inline, suggests a smaller model after a stopped engine, and retries", async () => {
  let fail = true;
  const s = setup({
    engine: {
      synthesize: vi.fn(async () => {
        if (fail) {
          fail = false;
          throw Object.assign(new Error("speech worker stopped: out of memory"), {
            name: "SpeechStoppedError",
          });
        }
        return { pcm: new Float32Array([0.1]).buffer, sampleRate: 24000 };
      }),
    },
  });
  await opened(s);
  await act(async () => s.result.current.generate());
  expect(s.result.current.view?.error).toMatchObject({ stopped: true });
  expect(s.result.current.view?.error?.message).toMatch(/6-layer model/);
  expect(s.result.current.view?.phase).toBe("idle");
  await act(async () => s.result.current.retry());
  expect(s.result.current.view?.error).toBeUndefined();
  expect(s.result.current.view?.current).toBe(true);
  // Each Generate asks the runtime again, so a stopped worker is replaced.
  expect(s.runtime.start).toHaveBeenCalledTimes(3);
});

it("reports an engine that cannot start and retries the boot", async () => {
  let attempts = 0;
  const s = setup({
    start: vi.fn(async () => {
      if (++attempts === 1) throw new Error("fetch speech.wasm: 404");
      return {
        catalog: TEST_SPEECH_CATALOG,
        loaded: () => ({ model: "", voices: [] }),
      } as unknown as SpeechEngine;
    }),
  });
  act(() => s.result.current.open(cursor));
  await waitFor(() => expect(s.result.current.view?.engine.status).toBe("failed"));
  expect(s.result.current.view?.engine).toMatchObject({ error: "fetch speech.wasm: 404" });
  act(() => {
    void s.result.current.retry();
  });
  await waitFor(() => expect(s.result.current.view?.engine.status).toBe("ready"));
});

it("does not generate from an invalid form", async () => {
  const s = setup();
  await opened(s);
  act(() => s.result.current.setForm({ text: " " }));
  await act(async () => s.result.current.generate());
  expect(s.engine.synthesize).not.toHaveBeenCalled();
  act(() => s.result.current.setModel("german_24l"));
  // A blank field takes the new model's sample text.
  expect(s.result.current.view?.form).toMatchObject({ voice: "juergen", text: "Hallo Welt." });
});
