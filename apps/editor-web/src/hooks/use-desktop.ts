import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CommandId, ResolvedCommand } from "@/lib/commands";
import { nativeMenu } from "@/lib/native-menu";
import { desktopBridge, type NativeFile } from "@/platform";

interface DesktopOptions {
  commands: readonly ResolvedCommand[];
  execute(id: CommandId): boolean;
  dirty: boolean;
  busy: boolean;
  canOpen: boolean;
  name?: string;
  save(): Promise<boolean> | undefined;
  openFile(file: NativeFile): Promise<void> | undefined;
  onError(error: unknown): void;
  onClosingChange(closing: boolean): void;
}
export function useDesktop(options: DesktopOptions) {
  const latest = useRef(options);
  latest.current = options;
  const bridge = desktopBridge();
  const [closing, setClosing] = useState(false);
  const menu = JSON.stringify(nativeMenu(options.commands));
  useEffect(() => {
    void bridge?.setMenu(JSON.parse(menu)).catch((error) => latest.current.onError(error));
  }, [bridge, menu]);
  useLayoutEffect(() => {
    void bridge
      ?.setDocumentState({
        dirty: options.dirty,
        busy: options.busy || closing,
        name: options.name,
      })
      .catch((error) => latest.current.onError(error));
  }, [bridge, options.dirty, options.busy, options.name, closing]);
  const queue = useRef<NativeFile[]>([]);
  const draining = useRef(false);
  const needsPull = useRef(false);
  const kick = useRef<() => void>(() => {});
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    kick.current = () => {
      if (!active || draining.current || !latest.current.canOpen) return;
      draining.current = true;
      needsPull.current = false;
      let consumed = false;
      void (async () => {
        queue.current.push(...(await bridge.takeOpenFiles()));
        while (active && latest.current.canOpen && queue.current.length) {
          const next = queue.current[0];
          const work = latest.current.openFile(next);
          if (!work) break;
          queue.current.shift();
          consumed = true;
          await work;
        }
      })()
        .catch((error) => latest.current.onError(error))
        .finally(() => {
          draining.current = false;
          if (
            active &&
            latest.current.canOpen &&
            (needsPull.current || (consumed && queue.current.length))
          )
            queueMicrotask(() => kick.current());
        });
    };
    const unsubscribeFiles = bridge.onOpenFiles(() => {
      needsPull.current = true;
      kick.current();
    });
    const unsubscribeCommands = bridge.onCommand((id) => {
      if (active && latest.current.commands.some((command) => command.id === id))
        latest.current.execute(id as CommandId);
    });
    const unsubscribeClose = bridge.onSaveBeforeClose((request) => {
      if (!active) return;
      setClosing(true);
      latest.current.onClosingChange(true);
      void (async () => {
        let saved = false;
        try {
          saved = (await latest.current.save()) ?? false;
        } catch (error) {
          latest.current.onError(error);
        } finally {
          try {
            await bridge.completeClose(request, saved);
          } finally {
            if (active) {
              setClosing(false);
              latest.current.onClosingChange(false);
            }
          }
        }
      })().catch((error) => latest.current.onError(error));
    });
    kick.current();
    return () => {
      active = false;
      unsubscribeFiles();
      unsubscribeCommands();
      unsubscribeClose();
    };
  }, [bridge]);
  useEffect(() => {
    if (options.canOpen) kick.current();
  }, [options.canOpen]);
  return { native: Boolean(bridge), closing };
}
