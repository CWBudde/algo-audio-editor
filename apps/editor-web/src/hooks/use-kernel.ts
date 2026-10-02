import type { HelloResult } from "@aae/protocol";
import { useEffect, useState } from "react";
import type { KernelClient } from "@/kernel/client";
import { startKernel } from "@/kernel/runtime";

export type KernelState =
  | { status: "loading" }
  | { status: "ready"; client: KernelClient; hello: HelloResult }
  | { status: "error"; error: string };

/** Boots the kernel on first use and tracks its lifecycle. */
export function useKernel(): KernelState {
  const [state, setState] = useState<KernelState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;

    startKernel().then(
      ({ client, hello }) => {
        if (!active) return;
        setState({ status: "ready", client, hello });
        unsubscribe = client.onFatal((error) => setState({ status: "error", error }));
      },
      (err: unknown) => {
        if (active) setState({ status: "error", error: String(err) });
      },
    );

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  return state;
}
