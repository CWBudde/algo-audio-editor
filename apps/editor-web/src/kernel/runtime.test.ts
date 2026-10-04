import { afterEach, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  clients: [] as { boot: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> }[],
  boot: undefined as (() => Promise<unknown>) | undefined,
}));
vi.mock("./client", () => ({
  KernelClient: class {
    boot = vi.fn(() => fakes.boot?.() ?? Promise.resolve({ protocolVersion: 18 }));
    terminate = vi.fn();
    constructor() {
      fakes.clients.push(this);
    }
  },
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  fakes.clients = [];
  fakes.boot = undefined;
});

it("keeps the editor singleton while fresh isolated workers are independently terminated", async () => {
  const workers: unknown[] = [];
  vi.stubGlobal(
    "Worker",
    class {
      constructor(...args: unknown[]) {
        workers.push(args);
      }
    },
  );
  const { startKernel, startIsolatedKernel } = await import("./runtime");
  const editor = await startKernel();
  const first = await startIsolatedKernel();
  const second = await startIsolatedKernel();
  expect(await startKernel()).toBe(editor);
  expect(first.client).not.toBe(second.client);
  expect(first.client).not.toBe(editor.client);
  first.client.terminate();
  second.client.terminate();
  expect(fakes.clients[0].terminate).not.toHaveBeenCalled();
  expect(workers).toHaveLength(3);
  expect(fakes.clients[0].boot).toHaveBeenCalledWith(
    expect.stringContaining(import.meta.env.VITE_KERNEL_FILE),
    expect.stringContaining(import.meta.env.VITE_GO_RUNTIME_FILE),
  );
});

it("terminates failed or cancelled boots and permits a failed editor boot to retry", async () => {
  const worker = vi.fn();
  vi.stubGlobal(
    "Worker",
    class {
      constructor() {
        worker();
      }
    },
  );
  const { startKernel, startIsolatedKernel } = await import("./runtime");
  fakes.boot = async () => {
    throw new Error("boot failed");
  };
  await expect(startKernel()).rejects.toThrow("boot failed");
  expect(fakes.clients[0].terminate).toHaveBeenCalledTimes(1);
  fakes.boot = undefined;
  await startKernel();
  const abort = new AbortController();
  let finish: (() => void) | undefined;
  fakes.boot = () =>
    new Promise((resolve) => {
      finish = () => resolve({});
    });
  const pending = startIsolatedKernel(abort.signal);
  abort.abort();
  expect(fakes.clients[2].terminate).toHaveBeenCalledTimes(1);
  finish?.();
  await expect(pending).rejects.toThrow("Batch cancelled");
  expect(fakes.clients[2].terminate).toHaveBeenCalledTimes(2);
  await expect(startIsolatedKernel(abort.signal)).rejects.toThrow("Batch cancelled");
  expect(worker).toHaveBeenCalledTimes(3);
});
