import type { OperationChain } from "@aae/protocol";
import { useLayoutEffect, useRef, useState } from "react";
import { type BatchFileProgress, runBatch } from "@/kernel/batch-runner";
import { type BatchDestination, batchDownloads, chooseBatchDirectory } from "@/lib/batch-output";
import {
  type BatchSettings,
  batchOutputNames,
  DEFAULT_BATCH_SETTINGS,
  updateBatchSettings,
} from "@/lib/batch-settings";
import { MAX_CHAIN_BYTES, parseOperationChain } from "@/lib/operation-chain";
import { desktopBridge } from "@/platform";

const emptyChain = (): OperationChain => ({ version: 1, operations: [] });
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function useBatch(currentMacro: OperationChain) {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [chain, setChain] = useState(emptyChain);
  const [settings, setSettings] = useState(DEFAULT_BATCH_SETTINGS);
  const [destination, setDestination] = useState<BatchDestination | undefined>(() =>
    desktopBridge() ? undefined : batchDownloads(),
  );
  const [progress, setProgress] = useState<BatchFileProgress[]>([]);
  const [working, setWorking] = useState(false);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState<string>();
  const latest = useRef({ files, chain, settings, destination, currentMacro });
  latest.current = { files, chain, settings, destination, currentMacro };
  const mounted = useRef(false);
  const pending = useRef(false);
  const controller = useRef<AbortController | undefined>(undefined);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      if (!pending.current) void latest.current.destination?.dispose?.();
    };
  }, []);

  async function configure(work: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setWorking(true);
    setError(undefined);
    try {
      await work();
    } catch (error) {
      if (mounted.current) setError(describe(error));
    } finally {
      pending.current = false;
      if (mounted.current) setWorking(false);
      else await latest.current.destination?.dispose?.();
    }
  }
  function resetProgress() {
    setProgress([]);
    setFinished(false);
    setError(undefined);
  }
  async function replaceDestination(next: BatchDestination) {
    if (!mounted.current) {
      await next.dispose?.();
      return;
    }
    const previous = latest.current.destination;
    latest.current.destination = next;
    setDestination(next);
    await previous?.dispose?.();
    resetProgress();
  }
  async function start() {
    if (pending.current || !latest.current.destination) return;
    const snapshot = latest.current;
    const abort = new AbortController();
    controller.current = abort;
    pending.current = true;
    setWorking(true);
    setRunning(true);
    setFinished(false);
    setError(undefined);
    setProgress(snapshot.files.map((_, index) => ({ index, state: "Waiting" })));
    try {
      batchOutputNames(snapshot.files, snapshot.settings);
      await runBatch(
        snapshot.files,
        snapshot.chain,
        snapshot.settings,
        snapshot.destination as BatchDestination,
        {
          signal: abort.signal,
          onProgress(update) {
            if (mounted.current)
              setProgress((rows) => rows.map((row) => (row.index === update.index ? update : row)));
          },
        },
      );
      if (mounted.current) setFinished(true);
    } catch (error) {
      if (mounted.current) {
        if (abort.signal.aborted)
          setProgress((rows) =>
            rows.map((row) =>
              ["Done", "Failed"].includes(row.state) ? row : { ...row, state: "Cancelled" },
            ),
          );
        else setError(describe(error));
      }
    } finally {
      controller.current = undefined;
      pending.current = false;
      if (mounted.current) {
        setWorking(false);
        setRunning(false);
      } else await snapshot.destination?.dispose?.();
    }
  }

  return {
    open,
    files,
    chain,
    settings,
    destination,
    progress,
    working,
    running,
    finished,
    error,
    show() {
      if (!pending.current) {
        if (
          !latest.current.chain.operations.length &&
          latest.current.currentMacro.operations.length
        )
          setChain(parseOperationChain(JSON.stringify(latest.current.currentMacro)));
        setOpen(true);
      }
    },
    close() {
      if (!pending.current) setOpen(false);
    },
    selectFiles(next: File[]) {
      if (pending.current) return;
      setFiles(next);
      resetProgress();
    },
    changeSettings(change: Partial<BatchSettings>) {
      if (pending.current) return;
      setSettings((previous) => updateBatchSettings(previous, change));
      resetProgress();
    },
    chooseMacro() {
      if (pending.current) return;
      setChain(parseOperationChain(JSON.stringify(latest.current.currentMacro)));
      resetProgress();
    },
    clearChain() {
      if (pending.current) return;
      setChain(emptyChain());
      resetProgress();
    },
    async load(file: File) {
      await configure(async () => {
        if (file.size > MAX_CHAIN_BYTES) throw new Error("Chain exceeds the 1 MiB limit.");
        const next = parseOperationChain(await file.text());
        if (mounted.current) {
          setChain(next);
          resetProgress();
        }
      });
    },
    async chooseFolder() {
      await configure(async () => {
        const next = await chooseBatchDirectory();
        if (next) await replaceDestination(next);
      });
    },
    async chooseDownloads() {
      if (desktopBridge()) return;
      await configure(() => replaceDestination(batchDownloads()));
    },
    start,
    cancel() {
      controller.current?.abort();
    },
  };
}
