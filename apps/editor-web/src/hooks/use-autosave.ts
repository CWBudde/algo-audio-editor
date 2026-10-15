import { useCallback, useEffect, useState } from "react";
import type { AutosaveStatus, RecoverableSession } from "@/kernel/autosave/types";
import type { KernelClient } from "@/kernel/client";

const CLOSED_PREFIX = "aae.autosave.closed.";

/**
 * A window that closes normally leaves its session behind like a crash does:
 * its lock is gone either way. This synchronous marker, written on pagehide,
 * tells the next start that the user already chose to leave that work.
 */
function markClosed(sessionId: string, closed: boolean) {
  try {
    if (closed) localStorage.setItem(CLOSED_PREFIX + sessionId, "1");
    else localStorage.removeItem(CLOSED_PREFIX + sessionId);
  } catch {
    /* Without storage a closed session is offered once, which is safe. */
  }
}

function closedSessions(): string[] {
  try {
    return Object.keys(localStorage)
      .filter((key) => key.startsWith(CLOSED_PREFIX))
      .map((key) => key.slice(CLOSED_PREFIX.length));
  } catch {
    return [];
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Starts this window's autosave and finds work that a crashed window left behind. */
export function useAutosave(client: KernelClient | undefined, enabled: boolean) {
  const [status, setStatus] = useState<AutosaveStatus>();
  const [failure, setFailure] = useState<string>();
  const [recoverable, setRecoverable] = useState<RecoverableSession[]>([]);
  /** The startup search for crashed sessions has finished, or could not run. */
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (!client || !enabled) return;
    let active = true;
    const unsubscribe = client.onAutosaveStatus((next) => {
      if (active) setStatus(next);
    });
    void (async () => {
      try {
        await client.enableAutosave();
        const closed = closedSessions();
        const { sessions } = await client.listRecoverable(closed);
        for (const sessionId of closed) markClosed(sessionId, false);
        if (active) setRecoverable(sessions);
      } catch (error) {
        if (active) setFailure(message(error));
      } finally {
        if (active) setChecked(true);
      }
    })();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [client, enabled]);

  const sessionId = status?.sessionId;
  useEffect(() => {
    if (!sessionId) return;
    const hide = () => markClosed(sessionId, true);
    // A page restored from the back/forward cache is open again.
    const show = (event: PageTransitionEvent) => {
      if (event.persisted) markClosed(sessionId, false);
    };
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    return () => {
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
    };
  }, [sessionId]);

  const forget = useCallback((sessionId: string) => {
    setRecoverable((sessions) => sessions.filter((session) => session.sessionId !== sessionId));
  }, []);

  const discard = useCallback(
    async (sessionId: string) => {
      if (!client) return;
      await client.discardRecoverable(sessionId);
      forget(sessionId);
    },
    [client, forget],
  );

  return {
    status,
    /** Autosave could not start; documents are not protected. */
    failure: failure ?? (status?.state === "error" ? status.error : undefined),
    recoverable,
    checked,
    forget,
    discard,
  };
}
