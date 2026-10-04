import type { DocumentInfoResult, EditResult, OperationChain } from "@aae/protocol";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { type ChainProgress, runOperationChain } from "@/kernel/chain-runner";
import type { KernelClient } from "@/kernel/client";
import { chooseSaveTarget } from "@/lib/file-access";
import {
  type AppliedOperation,
  MAX_CHAIN_BYTES,
  parseOperationChain,
  recordOperation,
  serializeOperationChain,
} from "@/lib/operation-chain";

interface Options {
  client?: KernelClient;
  info?: DocumentInfoResult;
  busy: boolean;
  withOperation(work: () => Promise<void>): Promise<void>;
  beforeEdit(): Promise<void>;
  onEdited(result: EditResult, sourceDocumentId: string): void;
}
const emptyChain = (): OperationChain => ({ version: 1, operations: [] });

export function useAutomation(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const mounted = useRef(false);
  const recordingRef = useRef(false);
  const chainRef = useRef(emptyChain());
  const [chain, setChain] = useState(chainRef.current);
  const [recording, setRecording] = useState(false);
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState<ChainProgress>();
  const [error, setError] = useState<string>();
  const pending = useRef(false);
  const controller = useRef<AbortController | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A replaced kernel cancels the previous client's replay.
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, [options.client]);
  const stopRecording = useCallback(() => {
    recordingRef.current = false;
    setRecording(false);
  }, []);
  const startRecording = useCallback(() => {
    if (latest.current.busy || pending.current || !latest.current.info) return;
    chainRef.current = emptyChain();
    setChain(chainRef.current);
    setError(undefined);
    recordingRef.current = true;
    setRecording(true);
    setOpen(false);
  }, []);
  const record = useCallback((operation: AppliedOperation, info: DocumentInfoResult) => {
    if (!mounted.current || !recordingRef.current) return;
    try {
      const next = {
        ...chainRef.current,
        operations: [...chainRef.current.operations, recordOperation(operation, info)],
      };
      // Enforce both caps while recording, not just when loading the JSON later.
      chainRef.current = parseOperationChain(JSON.stringify(next));
      setChain(chainRef.current);
    } catch (error) {
      recordingRef.current = false;
      setRecording(false);
      setError(
        `Recording stopped: ${error instanceof Error ? error.message : String(error)} The preceding operations are retained.`,
      );
      setOpen(true);
    }
  }, []);
  const load = useCallback(async (file: File) => {
    if (pending.current || recordingRef.current) return;
    pending.current = true;
    setWorking(true);
    setError(undefined);
    try {
      if (file.size > MAX_CHAIN_BYTES) throw new Error("Chain exceeds the 1 MiB limit.");
      const next = parseOperationChain(await file.text());
      if (mounted.current) {
        chainRef.current = next;
        setChain(next);
      }
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      pending.current = false;
      if (mounted.current) setWorking(false);
    }
  }, []);
  const save = useCallback(async () => {
    if (pending.current || recordingRef.current) return;
    pending.current = true;
    setWorking(true);
    setError(undefined);
    try {
      const destination = await chooseSaveTarget("macro.json", [
        { description: "Operation chain", accept: { "application/json": [".json"] } },
      ]);
      if (!destination) return;
      try {
        if (!mounted.current) return;
        const data = new TextEncoder().encode(serializeOperationChain(chainRef.current)).buffer;
        await destination.write({
          name: "macro.json",
          mimeType: "application/json",
          dataBytes: data.byteLength,
          data,
        });
      } finally {
        await destination.dispose?.();
      }
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      pending.current = false;
      if (mounted.current) setWorking(false);
    }
  }, []);
  const replay = useCallback(async () => {
    const initial = latest.current;
    if (
      !initial.client ||
      !initial.info ||
      initial.busy ||
      pending.current ||
      recordingRef.current ||
      !chainRef.current.operations.length
    )
      return;
    pending.current = true;
    const abort = new AbortController();
    controller.current = abort;
    setWorking(true);
    setError(undefined);
    setProgress({ completed: 0, total: chainRef.current.operations.length });
    try {
      await initial.withOperation(async () => {
        await initial.beforeEdit();
        await runOperationChain(
          initial.client as KernelClient,
          initial.info as DocumentInfoResult,
          chainRef.current,
          {
            signal: abort.signal,
            onEdited: (result, source) => {
              if (mounted.current && latest.current.client === initial.client)
                latest.current.onEdited(result, source);
            },
            onProgress: (progress) => {
              if (mounted.current) setProgress(progress);
            },
          },
        );
      });
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      controller.current = undefined;
      pending.current = false;
      if (mounted.current) setWorking(false);
    }
  }, []);
  return {
    chain,
    recording,
    open,
    working,
    progress,
    error,
    record,
    startRecording,
    stopRecording,
    load,
    save,
    replay,
    show: () => {
      setProgress(undefined);
      setOpen(true);
    },
    close: () => {
      if (!pending.current) setOpen(false);
    },
    cancel: () => controller.current?.abort(),
  };
}
