import { useEffect } from "react";
import { desktopBridge } from "@/platform";

function guard(event: BeforeUnloadEvent) {
  event.preventDefault();
  // Legacy browsers only show the prompt when returnValue is set.
  event.returnValue = "";
}

/**
 * Asks the browser to confirm closing or reloading the tab while the open
 * document has unsaved changes. The listener exists only while dirty, so a
 * clean editor stays eligible for the back/forward cache.
 *
 * Electron is excluded: its main process already asks Save/Discard/Cancel on
 * window close, and a renderer `beforeunload` cancellation would silently
 * block the close it allows after Discard or a successful save.
 */
export function useUnsavedChangesGuard(dirty: boolean) {
  const native = Boolean(desktopBridge());
  useEffect(() => {
    if (!dirty || native) return;
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty, native]);
}
