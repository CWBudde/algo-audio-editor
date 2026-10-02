import type { DocumentMemoryResult } from "@aae/protocol";
import { useEffect, useState } from "react";
import type { KernelClient } from "@/kernel/client";

const REFRESH_INTERVAL_MS = 1_000;

/** Refresh after each response, so slow calls never accumulate in the worker. */
export function useDocumentMemory(
  client: KernelClient | undefined,
): DocumentMemoryResult | undefined {
  const [snapshot, setSnapshot] = useState<{
    client: KernelClient;
    memory: DocumentMemoryResult | undefined;
  }>();

  useEffect(() => {
    if (!client) return;
    const target = client;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;

    async function refresh() {
      try {
        const memory = await target.call("doc.memory");
        if (active) setSnapshot({ client: target, memory });
      } catch {
        if (active) setSnapshot({ client: target, memory: undefined });
      } finally {
        if (active) timer = setTimeout(refresh, REFRESH_INTERVAL_MS);
      }
    }

    // Deferring the first call lets StrictMode cancel its initial effect before
    // issuing an RPC, and keeps the same cleanup path for subsequent refreshes.
    timer = setTimeout(refresh, 0);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [client]);

  return snapshot?.client === client ? snapshot?.memory : undefined;
}
