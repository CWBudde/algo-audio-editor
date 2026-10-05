import type { DocumentInfoResult, SelectionRange } from "@aae/protocol";
import { useCallback, useLayoutEffect, useRef } from "react";
import type { useSelection } from "@/hooks/use-selection";
import type { KernelClient } from "@/kernel/client";

interface KeyboardSelectionOptions {
  client: KernelClient | undefined;
  info: DocumentInfoResult;
  editor: ReturnType<typeof useSelection>;
  disabled: boolean;
  onSeek?: (frame: number) => void;
}

interface PendingSelection {
  options: KeyboardSelectionOptions;
  range: SelectionRange;
  seekFrame?: number;
}

/** Keyboard repeats paint immediately but send only the last selection and seek. */
export function useKeyboardSelection(options: KeyboardSelectionOptions) {
  const latest = useRef(options);
  latest.current = options;
  const mounted = useRef(false);
  const pending = useRef<PendingSelection | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearTimer = useCallback(() => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  const ownsPreview = useCallback(() => {
    const write = pending.current;
    return Boolean(write?.options.editor.isPreview(write.range));
  }, []);
  const cancel = useCallback(() => {
    clearTimer();
    const write = pending.current;
    pending.current = undefined;
    if (write?.options.editor.isPreview(write.range)) write.options.editor.cancelPreview();
  }, [clearTimer]);
  const flush = useCallback(() => {
    clearTimer();
    const write = pending.current;
    if (!write) return;
    const current = latest.current;
    if (
      !mounted.current ||
      current.disabled ||
      current.client !== write.options.client ||
      current.info !== write.options.info ||
      current.editor.preview !== write.options.editor.preview ||
      !write.options.editor.isPreview(write.range)
    ) {
      cancel();
      return;
    }
    pending.current = undefined;
    // Never attach a seek to an asynchronous selection ACK: the next input
    // could already have moved the cursor when that old response arrives.
    current.editor.commit(write.range);
    if (write.seekFrame !== undefined) current.onSeek?.(write.seekFrame);
  }, [cancel, clearTimer]);
  const change = useCallback(
    (range: SelectionRange, seekFrame?: number) => {
      const current = latest.current;
      if (
        !mounted.current ||
        current.disabled ||
        !current.client ||
        current.info.frames === 0 ||
        (current.editor.isPreview() && !ownsPreview())
      )
        return;
      clearTimer();
      pending.current = { options: current, range, seekFrame };
      current.editor.preview(range);
      timer.current = setTimeout(flush, 80);
    },
    [clearTimer, flush, ownsPreview],
  );

  const { client, info, editor, disabled } = options;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Replacing a selection session, document/client or busy state invalidates pending input.
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancel();
    };
  }, [client, info, editor.preview, disabled, cancel]);

  return { change, flush, cancel, ownsPreview };
}
