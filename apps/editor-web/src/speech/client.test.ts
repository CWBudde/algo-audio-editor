import { describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "@/platform";
import { TEST_SPEECH_CATALOG } from "./catalog-fixture";
import { SpeechClient, SpeechError, SpeechStoppedError, type SpeechWorkerLike } from "./client";
import type { SpeechReply, SpeechRequest, SpeechSynthesisParams } from "./messages";

/** In-memory speech worker whose replies are scripted by the test. */
class FakeWorker implements SpeechWorkerLike {
  sent: SpeechRequest[] = [];
  terminated = false;
  private listener?: (event: MessageEvent<SpeechReply>) => void;
  respond?: (req: SpeechRequest) => SpeechReply | SpeechReply[] | undefined;

  constructor(respond?: (req: SpeechRequest) => SpeechReply | SpeechReply[] | undefined) {
    this.respond = respond;
  }
  postMessage(message: SpeechRequest, transfer?: Transferable[]) {
    const received = transfer ? structuredClone(message, { transfer }) : message;
    this.sent.push(received);
    const replies = this.respond?.(received);
    for (const reply of Array.isArray(replies) ? replies : replies ? [replies] : [])
      queueMicrotask(() => this.emit(reply));
  }
  addEventListener(_type: "message", listener: (event: MessageEvent<SpeechReply>) => void) {
    this.listener = listener;
  }
  terminate() {
    this.terminated = true;
  }
  emit(reply: SpeechReply) {
    this.listener?.({ data: reply } as MessageEvent<SpeechReply>);
  }
}

const params: SpeechSynthesisParams = {
  model: "english_2026-01",
  voice: "alba",
  text: "Hello.",
  temperature: 0.3,
  samplerSteps: 1,
  eosThreshold: -4,
  seed: 7,
};

/** Answers init and ensure like speech.worker.ts; synthesize returns two samples. */
function worker(extra?: (req: SpeechRequest) => SpeechReply | SpeechReply[] | undefined) {
  return new FakeWorker((req) => {
    const custom = extra?.(req);
    if (custom) return custom;
    if (req.op === "init")
      return {
        kind: "reply",
        id: req.id,
        ok: true,
        result: { catalog: TEST_SPEECH_CATALOG, sampleRate: 24000 },
      };
    if (req.op === "ensure")
      return [
        {
          kind: "progress",
          id: req.id,
          progress: { stage: "download", path: "x", done: 1, total: 2 },
        },
        { kind: "progress", id: req.id, progress: { stage: "load" } },
        {
          kind: "reply",
          id: req.id,
          ok: true,
          result: { model: req.model, voices: [req.voice] },
        },
      ];
    if (req.op === "synthesize")
      return [
        {
          kind: "progress",
          id: req.id,
          progress: { stage: "synthesize", chunk: 1, chunks: 2, step: 3, maxSteps: 10 },
        },
        {
          kind: "reply",
          id: req.id,
          ok: true,
          result: { pcm: new Float32Array([0.25, -0.5]).buffer, sampleRate: 24000 },
        },
      ];
    if (req.op === "cancel" || req.op === "unload")
      return { kind: "reply", id: req.id, ok: true, result: undefined };
  });
}

async function booted(fake: FakeWorker, options?: ConstructorParameters<typeof SpeechClient>[1]) {
  const client = new SpeechClient(fake, options);
  expect(await client.boot("/speech.wasm", "/wasm_exec.js")).toEqual(TEST_SPEECH_CATALOG);
  return client;
}

describe("SpeechClient", () => {
  it("boots, loads a model from the catalog URLs and skips what is already loaded", async () => {
    const fake = worker();
    const client = await booted(fake);
    expect(client.sampleRate).toBe(24000);
    const progress = vi.fn();
    await client.ensureModel("english_2026-01", "alba", progress);
    const ensure = fake.sent.find((req) => req.op === "ensure");
    expect(ensure).toMatchObject({
      op: "ensure",
      model: "english_2026-01",
      voice: "alba",
      weights: { source: TEST_SPEECH_CATALOG.models[0].weights.url },
      tokenizer: { path: "english_2026-01/tokenizer.model" },
      voiceFile: { path: "english_2026-01/voices/alba.safetensors" },
    });
    expect(progress.mock.calls.map(([value]) => value.stage)).toEqual(["download", "load"]);
    expect(client.loaded()).toEqual({ model: "english_2026-01", voices: ["alba"] });
    await client.ensureModel("english_2026-01", "alba");
    expect(fake.sent.filter((req) => req.op === "ensure")).toHaveLength(1);
  });

  it("asks the desktop main process to download and labels the local copy as reading", async () => {
    const bridge = {
      ensureSpeechModels: vi.fn(async () => "app://editor/speech-models/"),
    } as unknown as DesktopBridge;
    const fake = worker();
    const client = await booted(fake, { bridge });
    const progress = vi.fn();
    await client.ensureModel("german_24l", "juergen", progress);
    expect(bridge.ensureSpeechModels).toHaveBeenCalledTimes(1);
    expect(fake.sent.find((req) => req.op === "ensure")).toMatchObject({
      weights: { source: "app://editor/speech-models/german_24l/model.safetensors" },
    });
    expect(progress.mock.calls[0][0]).toMatchObject({ stage: "read", done: 1, total: 2 });
  });

  it("returns synthesized PCM with progress", async () => {
    const client = await booted(worker());
    const progress = vi.fn();
    const result = await client.synthesize(params, progress);
    expect(result.sampleRate).toBe(24000);
    expect([...new Float32Array(result.pcm)]).toEqual([0.25, -0.5]);
    expect(progress).toHaveBeenCalledWith({
      stage: "synthesize",
      chunk: 1,
      chunks: 2,
      step: 3,
      maxSteps: 10,
    });
  });

  it("rejects malformed PCM", async () => {
    const client = await booted(
      worker((req) =>
        req.op === "synthesize"
          ? {
              kind: "reply",
              id: req.id,
              ok: true,
              result: { pcm: new ArrayBuffer(3), sampleRate: 24000 },
            }
          : undefined,
      ),
    );
    await expect(client.synthesize(params)).rejects.toThrow(/malformed PCM/);
  });

  it("cancels the worker on abort and rejects with AbortError", async () => {
    let synthesis: SpeechRequest | undefined;
    const fake = worker((req) => {
      if (req.op === "synthesize") {
        synthesis = req;
        return [];
      }
      if (req.op === "cancel" && synthesis)
        return [
          { kind: "reply", id: synthesis.id, ok: false, error: "speech: context canceled" },
          { kind: "reply", id: req.id, ok: true, result: undefined },
        ];
    });
    const client = await booted(fake);
    const abort = new AbortController();
    const pending = client.synthesize(params, undefined, abort.signal);
    await Promise.resolve();
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.sent.some((req) => req.op === "cancel")).toBe(true);
  });

  it("reports worker errors as SpeechError", async () => {
    const client = await booted(
      worker((req) =>
        req.op === "ensure"
          ? { kind: "reply", id: req.id, ok: false, error: "checksum mismatch" }
          : undefined,
      ),
    );
    const failure = client.ensureModel("english_2026-01", "alba");
    await expect(failure).rejects.toBeInstanceOf(SpeechError);
    await expect(failure).rejects.toThrow("checksum mismatch");
    expect(client.loaded()).toEqual({ model: "", voices: [] });
  });

  it("fails pending and later calls once the Go program stops", async () => {
    const fake = worker((req) => (req.op === "synthesize" ? [] : undefined));
    const client = await booted(fake);
    await client.ensureModel("english_2026-01", "alba");
    const fatal = vi.fn();
    client.onFatal(fatal);
    const pending = client.synthesize(params);
    fake.emit({ kind: "fatal", error: "speech engine stopped" });
    await expect(pending).rejects.toBeInstanceOf(SpeechStoppedError);
    expect(fatal).toHaveBeenCalledWith("speech engine stopped");
    expect(client.stopped).toBe(true);
    expect(client.loaded()).toEqual({ model: "", voices: [] });
    await expect(client.synthesize(params)).rejects.toBeInstanceOf(SpeechStoppedError);
  });

  it("terminates a worker whose boot does not answer", async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeWorker();
      const client = new SpeechClient(fake, { bootTimeoutMs: 100 });
      const boot = client.boot("/speech.wasm", "/wasm_exec.js");
      vi.advanceTimersByTime(100);
      await expect(boot).rejects.toBeInstanceOf(SpeechStoppedError);
      expect(fake.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
