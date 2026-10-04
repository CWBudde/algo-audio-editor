import { useCallback, useLayoutEffect, useMemo, useRef } from "react";

/** Shared lifetime/identity fence. Capture before awaiting; check before publishing.
 * Identity may be a document snapshot, modal document ID, or a selection store.
 * Cleanup still belongs to each owner, including authoritative late commits. */
export function useKernelSession<Options, Token = object>(
  options: Options,
  client: unknown,
  identity: unknown = client,
  onInvalidate?: () => void,
) {
  const latest = useRef(options);
  latest.current = options;
  const cleanup = useRef(onInvalidate);
  cleanup.current = onInvalidate;
  const mounted = useRef(false);
  const epoch = useRef(0);
  const token = useRef<Token | undefined>(undefined);
  const current = useRef({ client, identity });
  current.current = { client, identity };
  // biome-ignore lint/correctness/useExhaustiveDependencies: Identity changes run owner cleanup even when the effect reads only refs.
  useLayoutEffect(() => {
    mounted.current = true;
    epoch.current++;
    const invalidate = cleanup.current;
    return () => {
      mounted.current = false;
      epoch.current++;
      invalidate?.();
    };
  }, [client, identity]);
  const capture = useCallback((owner?: Token) => {
    const started = epoch.current;
    const initial = current.current;
    return () =>
      mounted.current &&
      epoch.current === started &&
      current.current.client === initial.client &&
      current.current.identity === initial.identity &&
      (owner === undefined || token.current === owner);
  }, []);
  const active = useCallback((owner: Token) => mounted.current && token.current === owner, []);
  return useMemo(() => ({ latest, mounted, epoch, token, capture, active }), [capture, active]);
}
