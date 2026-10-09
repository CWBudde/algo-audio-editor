import { type RefObject, useLayoutEffect, useRef } from "react";

/**
 * Shows a `<dialog>` modally while `open` and returns focus to its launcher afterwards.
 * Keep the dialog mounted while closed: the launcher is usually disabled while a modal is
 * open, and only an effect that runs after React re-enables it can focus it again.
 */
export function useRestoringModal(
  open: boolean,
  initialFocus: RefObject<HTMLElement | null>,
  fallbackFocusRef?: RefObject<HTMLElement | null>,
) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | undefined>(undefined);
  const latestOpen = useRef(open);
  latestOpen.current = open;
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!open) {
      // Restore after React's commit-time focus restoration, once the launcher is enabled again.
      const target = opener.current?.isConnected ? opener.current : fallbackFocusRef?.current;
      if (opener.current) target?.focus({ preventScroll: true });
      opener.current = undefined;
      return;
    }
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement ? active : undefined;
    // Menu items can disappear when their popup closes. Restore the owning trigger instead.
    if (opener.current?.closest("[role='menu']")) {
      opener.current =
        document.querySelector<HTMLElement>("[aria-haspopup='menu'][aria-expanded='true']") ??
        opener.current;
    }
    if (!element.open) element.showModal();
    initialFocus.current?.focus();
    return () => {
      if (element.open) element.close();
      if (!latestOpen.current) return;
      const target = opener.current?.isConnected ? opener.current : fallbackFocusRef?.current;
      target?.focus({ preventScroll: true });
      opener.current = undefined;
    };
  }, [open, initialFocus, fallbackFocusRef]);
  return dialog;
}
