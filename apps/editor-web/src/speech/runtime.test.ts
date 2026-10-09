import { afterEach, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  clients: [] as {
    boot: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
    fatal?: (error: string) => void;
  }[],
  boot: undefined as (() => Promise<unknown>) | undefined,
}));
vi.mock("./client", () => ({
  SpeechClient: class {
    boot = vi.fn(() => fakes.boot?.() ?? Promise.resolve({ default: "", models: [] }));
    terminate = vi.fn();
    fatal?: (error: string) => void;
    onFatal(listener: (error: string) => void) {
      this.fatal = listener;
      return () => {};
    }
    constructor() {
      fakes.clients.push(this);
    }
  },
}));
const workers: unknown[][] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
  fakes.clients = [];
  fakes.boot = undefined;
  workers.length = 0;
});
function stubWorker() {
  vi.stubGlobal(
    "Worker",
    class {
      constructor(...args: unknown[]) {
        workers.push(args);
      }
    },
  );
}

it("starts one named speech worker on demand and a fresh one after the Go program stops", async () => {
  stubWorker();
  const { startSpeech } = await import("./runtime");
  const first = await startSpeech();
  expect(await startSpeech()).toBe(first);
  expect(workers).toHaveLength(1);
  expect(workers[0][1]).toEqual({ type: "module", name: "aae-speech" });
  expect(fakes.clients[0].boot).toHaveBeenCalledWith(
    expect.stringContaining(import.meta.env.VITE_SPEECH_FILE),
    expect.stringContaining(import.meta.env.VITE_GO_RUNTIME_FILE),
  );
  fakes.clients[0].fatal?.("out of memory");
  const second = await startSpeech();
  expect(second).not.toBe(first);
  expect(workers).toHaveLength(2);
});

it("terminates a failed boot so the next start retries", async () => {
  stubWorker();
  fakes.boot = () => Promise.reject(new Error("fetch speech.wasm: 404"));
  const { startSpeech } = await import("./runtime");
  await expect(startSpeech()).rejects.toThrow("404");
  expect(fakes.clients[0].terminate).toHaveBeenCalled();
  fakes.boot = undefined;
  await startSpeech();
  expect(workers).toHaveLength(2);
});

it("ends the worker only after the last holder has been gone for the idle period", async () => {
  vi.useFakeTimers();
  stubWorker();
  const { holdSpeech, startSpeech, SPEECH_IDLE_MS } = await import("./runtime");
  const dialog = holdSpeech();
  const chain = holdSpeech();
  await startSpeech();
  dialog();
  dialog();
  await vi.advanceTimersByTimeAsync(SPEECH_IDLE_MS);
  expect(fakes.clients[0].terminate).not.toHaveBeenCalled();
  chain();
  await vi.advanceTimersByTimeAsync(SPEECH_IDLE_MS - 1);
  expect(fakes.clients[0].terminate).not.toHaveBeenCalled();
  // Reopening within the idle period keeps the loaded model.
  const reopened = holdSpeech();
  await vi.advanceTimersByTimeAsync(SPEECH_IDLE_MS);
  expect(fakes.clients[0].terminate).not.toHaveBeenCalled();
  reopened();
  await vi.advanceTimersByTimeAsync(SPEECH_IDLE_MS);
  expect(fakes.clients[0].terminate).toHaveBeenCalledTimes(1);
  await startSpeech();
  expect(workers).toHaveLength(2);
});
