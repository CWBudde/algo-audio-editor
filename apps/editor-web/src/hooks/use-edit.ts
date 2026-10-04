import type {
  ClipboardInfo,
  DocumentInfoResult,
  EditOperation,
  EditResult,
  PastePlan,
  SelectionRange,
} from "@aae/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { useKernelSession } from "@/hooks/use-kernel-session";
import type { KernelClient } from "@/kernel/client";
import type { AppliedOperation } from "@/lib/operation-chain";

export interface EditOptions {
  client: KernelClient | undefined;
  info: DocumentInfoResult | undefined;
  busy?: boolean;
  beforeEdit(): Promise<void>;
  onRecorded?(operation: AppliedOperation, info: DocumentInfoResult): void;
  onEdited(result: EditResult, sourceDocumentId: string): void;
  refreshDocument?(client: KernelClient): Promise<void>;
  confirmConversion(plan: PastePlan): Promise<boolean>;
  onError(action: string, error: unknown): void;
  withOperation?(work: () => Promise<void>): Promise<void>;
}

/** Control-only edit orchestration. The kernel owns clipboard and audio edits. */
export function useEdit(options: EditOptions) {
  const {
    latest,
    mounted,
    token: operation,
    capture,
  } = useKernelSession<EditOptions, object>(options, options.client, options.info, () =>
    cancelConfirmation.current?.(),
  );
  const cancelConfirmation = useRef<(() => void) | undefined>(undefined);
  const clipboardRevision = useRef(0);
  const [busy, setBusy] = useState(false);
  const [clipboardState, setClipboard] = useState<{
    client: KernelClient;
    value: ClipboardInfo;
  }>();

  useEffect(() => {
    const client = options.client;
    if (!client) return;
    let active = true;
    const revision = clipboardRevision.current;
    void client.call("edit.state").then(
      (value) => {
        if (active && latest.current.client === client && clipboardRevision.current === revision)
          setClipboard({ client, value });
      },
      (error: unknown) => {
        if (active && latest.current.client === client && clipboardRevision.current === revision)
          latest.current.onError("Could not read clipboard", error);
      },
    );
    return () => {
      active = false;
    };
  }, [options.client, latest]);

  const run = useCallback(
    async (kind: EditOperation, selection: SelectionRange, frames?: number) => {
      const initial = latest.current;
      const { client, info } = initial;
      if (!mounted.current || !client || !info || initial.busy || operation.current) return;
      const token = {};
      const range = {
        start: selection.start,
        end: selection.end,
        channelMask: selection.channelMask,
      };
      const sourceDocumentId = info.documentId;
      operation.current = token;
      setBusy(true);
      const active = capture(token);
      const work = async () => {
        if (!active()) return;
        let clipboardVersion: string | undefined;
        let convert: boolean | undefined;
        if (kind.startsWith("paste-")) {
          // Read the current kernel version, not a possibly stale UI snapshot.
          const current = await client.call("edit.state");
          if (!active()) return;
          clipboardRevision.current++;
          setClipboard({ client, value: current });
          if (!current.available) return;
          const plan = await client.call("edit.prepare-paste", {
            documentId: sourceDocumentId,
            channelMask: range.channelMask,
            clipboardVersion: current.version,
          });
          if (!active()) return;
          clipboardVersion = plan.clipboardVersion;
          if (plan.conversionRequired) {
            let cancel: (() => void) | undefined;
            const cancelled = new Promise<boolean>((resolve) => {
              cancel = () => resolve(false);
              cancelConfirmation.current = cancel;
            });
            try {
              convert = await Promise.race([
                Promise.resolve().then(() =>
                  active() ? latest.current.confirmConversion(plan) : false,
                ),
                cancelled,
              ]);
            } finally {
              if (cancelConfirmation.current === cancel) cancelConfirmation.current = undefined;
            }
            if (!convert || !active()) return;
          }
        }
        if (kind !== "copy") {
          await latest.current.beforeEdit();
          if (!active()) return;
        }
        const params = {
          documentId: sourceDocumentId,
          ...range,
          operation: kind,
          ...(frames === undefined ? {} : { frames }),
          ...(clipboardVersion === undefined ? {} : { clipboardVersion }),
          ...(convert === undefined ? {} : { convert }),
        };
        const result = await client.call("edit.apply", params);
        if (!active()) {
          if (result.changed && mounted.current && latest.current.client === client)
            await latest.current.refreshDocument?.(client);
          return;
        }
        clipboardRevision.current++;
        setClipboard({ client, value: result.clipboard });
        latest.current.onRecorded?.({ method: "edit.apply", params }, info);
        latest.current.onEdited(result, sourceDocumentId);
      };
      try {
        if (initial.withOperation) await initial.withOperation(work);
        else await work();
      } catch (error) {
        if (active()) latest.current.onError(`Could not ${kind}`, error);
      } finally {
        if (operation.current === token) operation.current = undefined;
        if (mounted.current) setBusy(false);
      }
    },
    [capture, latest, mounted, operation],
  );

  const acceptClipboard = useCallback(
    (value: ClipboardInfo) => {
      const client = latest.current.client;
      if (!mounted.current || !client) return;
      clipboardRevision.current++;
      setClipboard({ client, value });
    },
    [latest, mounted],
  );

  return {
    acceptClipboard,
    busy,
    clipboard: clipboardState?.client === options.client ? clipboardState?.value : undefined,
    run,
  };
}
