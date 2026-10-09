import { desktopBridge } from "@/platform";
import { SpeechClient } from "./client";

/** A closed dialog keeps its model this long before the worker and its memory are released. */
export const SPEECH_IDLE_MS = 5 * 60_000;

let runtime: Promise<SpeechClient> | undefined;
let holders = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function publicUrl(file: string): string {
  return new URL(`${import.meta.env.BASE_URL}${file}`, window.location.href).href;
}

/**
 * The page's speech worker, started on first use. A failed boot or a stopped
 * Go program (out of memory) clears it, so the next call starts a fresh one.
 */
export function startSpeech(): Promise<SpeechClient> {
  if (runtime) return runtime;
  const worker = new Worker(new URL("./speech.worker.ts", import.meta.url), {
    type: "module",
    name: "aae-speech",
  });
  const client = new SpeechClient(worker, { bridge: desktopBridge() });
  const started = client
    .boot(
      publicUrl(import.meta.env.VITE_SPEECH_FILE),
      publicUrl(import.meta.env.VITE_GO_RUNTIME_FILE),
    )
    .then(
      () => client,
      (error: unknown) => {
        client.terminate();
        throw error;
      },
    );
  runtime = started;
  const forget = () => {
    if (runtime === started) runtime = undefined;
  };
  client.onFatal(forget);
  started.catch(forget);
  return started;
}

/** Ends the worker; the next startSpeech() boots a new one. */
export function stopSpeech(): void {
  const current = runtime;
  runtime = undefined;
  void current?.then(
    (client) => client.terminate(),
    () => {},
  );
}

/**
 * Keeps the worker alive while a dialog or chain uses speech. When the last
 * holder releases it, the worker (and the model memory it holds, which WASM
 * cannot return otherwise) ends after SPEECH_IDLE_MS.
 */
export function holdSpeech(): () => void {
  holders++;
  clearTimeout(idleTimer);
  idleTimer = undefined;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders--;
    if (holders > 0) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      if (holders === 0) stopSpeech();
    }, SPEECH_IDLE_MS);
  };
}
