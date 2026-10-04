import type { DocumentInfoResult, OperationChain } from "@aae/protocol";
import { openAudioDocument } from "@/lib/audio-codecs";
import type { BatchDestination } from "@/lib/batch-output";
import { type BatchSettings, batchOutputNames } from "@/lib/batch-settings";
import { parseOperationChain } from "@/lib/operation-chain";
import { runOperationChain } from "./chain-runner";
import { type KernelRuntime, startIsolatedKernel } from "./runtime";

export type BatchFileState =
  | "Waiting"
  | "Opening"
  | "Processing"
  | "Exporting"
  | "Saving"
  | "Done"
  | "Failed"
  | "Cancelled";
export interface BatchFileProgress {
  index: number;
  state: BatchFileState;
  completed?: number;
  total?: number;
  phase?: string;
  error?: string;
}

/** File orchestration only. Each file has a fresh isolated Go engine, including clipboard/jobs. */
export async function runBatch(
  files: readonly File[],
  input: OperationChain,
  settings: BatchSettings,
  destination: BatchDestination,
  options: {
    signal?: AbortSignal;
    onProgress(progress: BatchFileProgress): void;
    createRuntime?: (signal?: AbortSignal) => Promise<KernelRuntime>;
  },
): Promise<void> {
  const names = batchOutputNames(files, settings);
  const chain = parseOperationChain(JSON.stringify(input));
  const cancelled = () => {
    if (options.signal?.aborted) throw new DOMException("Batch cancelled", "AbortError");
  };
  cancelled();
  await destination.preflight(names);
  for (let index = 0; index < files.length; index++) {
    if (options.signal?.aborted) {
      options.onProgress({ index, state: "Cancelled" });
      continue;
    }
    let runtime: KernelRuntime | undefined;
    const abort = () => runtime?.client.terminate();
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      options.onProgress({ index, state: "Opening" });
      if (files[index].size > 128 * 1024 * 1024)
        throw new Error("Encoded audio exceeds the 128 MiB batch input limit.");
      const data = await files[index].arrayBuffer();
      cancelled();
      runtime = await (options.createRuntime ?? startIsolatedKernel)(options.signal);
      cancelled();
      const opened = await openAudioDocument(
        runtime.client,
        files[index].name,
        data,
        () => !options.signal?.aborted,
      );
      cancelled();
      if (!opened) throw new Error("Audio import did not produce a document.");
      let info: DocumentInfoResult = opened;
      await runOperationChain(runtime.client, info, chain, {
        signal: options.signal,
        failureContext: "This file was skipped; no output was saved.",
        onEdited(result) {
          info = result.document;
        },
        onProgress(progress) {
          options.onProgress({
            index,
            state: "Processing",
            completed: progress.completed,
            total: progress.total,
            phase: progress.job?.phase,
          });
        },
      });
      cancelled();
      options.onProgress({ index, state: "Exporting" });
      const exported = await runtime.client.call("doc.export", {
        documentId: info.documentId,
        format: settings.format,
        bitDepth: settings.bitDepth,
        float: settings.encoding === "float",
        scope: "document",
        dither: "none",
        noiseShaping: "none",
      });
      cancelled();
      options.onProgress({ index, state: "Saving" });
      // Once publication starts it is authoritative; cancel only prevents later files.
      await destination.write({ ...exported, name: names[index] });
      options.onProgress({ index, state: "Done" });
    } catch (error) {
      options.onProgress({
        index,
        state: options.signal?.aborted ? "Cancelled" : "Failed",
        ...(!options.signal?.aborted && {
          error: error instanceof Error ? error.message : String(error),
        }),
      });
    } finally {
      options.signal?.removeEventListener("abort", abort);
      runtime?.client.terminate();
    }
  }
}
