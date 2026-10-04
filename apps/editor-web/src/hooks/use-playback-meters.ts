import type { DocumentInfoResult } from "@aae/protocol";
import { useEffect, useState } from "react";
import { createMeterBuffer, MeterReader, type MeterSnapshot } from "@/audio/meter-data";
import type { KernelClient } from "@/kernel/client";

export function usePlaybackMeters(
  client: KernelClient | undefined,
  info: DocumentInfoResult | undefined,
  enabled: boolean,
) {
  const documentId = info?.documentId;
  const [snapshot, setSnapshot] = useState<MeterSnapshot>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    setSnapshot(undefined);
    setError(undefined);
    if (!client || !documentId || !enabled) return;
    let active = true;
    const buffer = createMeterBuffer();
    const reader = new MeterReader(buffer);
    let timer: ReturnType<typeof setInterval> | undefined;
    void (async () => {
      await client.attachMeters(buffer);
      if (!active) return;
      await client.call("meters.configure", { enabled: true, reset: true });
      if (!active) return;
      const read = () => {
        if (active) {
          const snapshot = reader.read();
          if (snapshot) setSnapshot(snapshot);
        }
      };
      read();
      timer = setInterval(read, 50);
    })().catch((error: unknown) => {
      if (active) setError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      active = false;
      clearInterval(timer);
      void client.attachMeters().catch(() => {});
      void client.call("meters.configure", { enabled: false }).catch(() => {});
    };
  }, [client, documentId, enabled]);
  return { snapshot, error };
}
