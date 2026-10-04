import type { HelloResult } from "@aae/protocol";
import { KernelClient } from "./client";

export interface KernelRuntime {
  client: KernelClient;
  hello: HelloResult;
}

let runtime: Promise<KernelRuntime> | undefined;

/** Absolute URL of a file in public/, so it resolves the same inside the worker. */
function publicUrl(file: string): string {
  return new URL(`${import.meta.env.BASE_URL}${file}`, window.location.href).href;
}

/**
 * Starts the kernel worker once per page. The promise is cached so React
 * StrictMode's double mount, or several components asking at once, share one
 * kernel. A failed boot clears the cache so a retry starts from scratch.
 */
export function startKernel(): Promise<KernelRuntime> {
  runtime ??= (async () => {
    const worker = new Worker(new URL("./kernel.worker.ts", import.meta.url), {
      type: "module",
      name: "aae-kernel",
    });
    const client = new KernelClient(worker);
    try {
      const hello = await client.boot(
        publicUrl(import.meta.env.VITE_KERNEL_FILE),
        publicUrl(import.meta.env.VITE_GO_RUNTIME_FILE),
      );
      return { client, hello };
    } catch (err) {
      client.terminate();
      runtime = undefined;
      throw err;
    }
  })();
  return runtime;
}
