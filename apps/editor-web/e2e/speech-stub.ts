/// <reference lib="dom" />
import type { Page } from "@playwright/test";

declare global {
  interface Window {
    __aaeSpeech?: { requests: { op: string; [key: string]: unknown }[] };
  }
}

/** Samples of the synthetic speech: 0.1 s of a constant 0.25 at 24 kHz. */
export const STUB_SPEECH_SAMPLES = 2400;

/**
 * Replaces the speech worker (name "aae-speech") with a module worker that
 * speaks its message protocol without speech.wasm, models or network. Text
 * containing "fail" fails synthesis; text containing "wait" synthesizes until
 * cancelled. Requests are logged in window.__aaeSpeech.requests.
 */
export async function installSpeechStub(page: Page) {
  await page.addInitScript((samples) => {
    const file = (path: string, size: number) => ({
      url: `https://huggingface.co/kyutai/stub/resolve/${"0".repeat(40)}/${path}`,
      sha256: "0".repeat(64),
      size,
      path,
    });
    const catalog = {
      default: "english_2026-01",
      models: [
        {
          name: "english_2026-01",
          label: "English (Jan 2026)",
          language: "en",
          layers: 6,
          default_voice: "alba",
          default_temperature: 0.3,
          default_text: "Hello world.",
          weights: file("english_2026-01/model.safetensors", 235738732),
          tokenizer: file("english_2026-01/tokenizer.model", 59339),
          voices: [
            { id: "alba", ...file("english_2026-01/voices/alba.safetensors", 512088) },
            { id: "marius", ...file("english_2026-01/voices/marius.safetensors", 512088) },
          ],
        },
      ],
    };
    const source = `
      const catalog = ${JSON.stringify(catalog)};
      let waiting;
      const reply = (id, result, transfer = []) =>
        postMessage({ kind: "reply", id, ok: true, result }, transfer);
      const fail = (id, error) => postMessage({ kind: "reply", id, ok: false, error });
      const progress = (id, value) => postMessage({ kind: "progress", id, progress: value });
      self.onmessage = ({ data }) => {
        const { id, op } = data;
        if (op === "init") return reply(id, { catalog, sampleRate: 24000 });
        if (op === "ensure") {
          progress(id, { stage: "download", path: "x", done: 1, total: 2 });
          progress(id, { stage: "load" });
          return reply(id, { model: data.model, voices: [data.voice] });
        }
        if (op === "synthesize") {
          progress(id, { stage: "synthesize", chunk: 1, chunks: 2, step: 1, maxSteps: 10 });
          if (data.params.text.includes("fail")) return fail(id, "speech: synthetic failure");
          if (data.params.text.includes("wait")) {
            waiting = id;
            return;
          }
          const pcm = new Float32Array(${samples}).fill(0.25).buffer;
          return reply(id, { pcm, sampleRate: 24000 }, [pcm]);
        }
        if (op === "cancel") {
          if (waiting !== undefined) fail(waiting, "speech: context canceled");
          waiting = undefined;
          return reply(id, undefined);
        }
        if (op === "unload") return reply(id, undefined);
      };
    `;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const requests: { op: string }[] = [];
    window.__aaeSpeech = { requests };
    const Base = window.Worker;
    window.Worker = class extends Base {
      private readonly speech: boolean;
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        const speech = options?.name === "aae-speech";
        super(speech ? url : scriptURL, options);
        this.speech = speech;
      }
      override postMessage(
        message: unknown,
        transfer?: Transferable[] | StructuredSerializeOptions,
      ) {
        if (this.speech) requests.push(structuredClone(message) as { op: string });
        if (Array.isArray(transfer)) super.postMessage(message, transfer);
        else super.postMessage(message, transfer);
      }
    };
  }, STUB_SPEECH_SAMPLES);
}

export async function speechRequests(page: Page) {
  return page.evaluate(() => window.__aaeSpeech?.requests ?? []);
}
