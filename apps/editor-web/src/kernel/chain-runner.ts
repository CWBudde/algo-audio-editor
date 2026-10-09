import {
  CHAIN_SPEECH_GENERATE,
  type DocumentInfoResult,
  type EditApplyParams,
  type EditResult,
  type EffectPreviewParams,
  type OperationChain,
  type ProcessJobResult,
  type ProcessStartParams,
  type SelectionRange,
  type SpeechGenerateParams,
} from "@aae/protocol";
import { parseOperationChain } from "@/lib/operation-chain";
import type { SpeechSynthesisParams, SpeechSynthesisResult } from "@/speech/messages";
import type { KernelClient } from "./client";

/** Turns a speech.generate step into PCM; the editor's speech worker by default. */
export type ChainSynthesizer = (
  params: SpeechSynthesisParams,
  signal?: AbortSignal,
) => Promise<SpeechSynthesisResult>;

const workerSynthesizer: ChainSynthesizer = async (params, signal) =>
  (await import("@/speech/synthesize")).synthesizeSpeech(params, { signal });

export interface ChainProgress {
  completed: number;
  total: number;
  job?: ProcessJobResult;
  committing?: boolean;
}

/** Control orchestration only: existing bounded Go jobs own all audio work. */
export async function runOperationChain(
  client: KernelClient,
  initial: DocumentInfoResult,
  input: OperationChain,
  options: {
    signal?: AbortSignal;
    onEdited(result: EditResult, sourceDocumentId: string): void;
    onProgress?(progress: ChainProgress): void;
    failureContext?: string;
    synthesize?: ChainSynthesizer;
  },
): Promise<number> {
  const chain = parseOperationChain(JSON.stringify(input));
  let info = initial;
  let completed = 0;
  const cancelled = () => {
    if (options.signal?.aborted) throw new DOMException("Macro cancelled", "AbortError");
  };
  try {
    for (const op of chain.operations) {
      cancelled();
      const selection: SelectionRange =
        op.range === "document"
          ? { start: 0, end: info.frames, channelMask: 2 ** info.channels - 1 }
          : await client.call("selection.get", { documentId: info.documentId });
      cancelled();
      const params = { ...selection, ...op.params, documentId: info.documentId };
      let result: EditResult;
      if (op.method === "edit.apply") {
        const edit = params as EditApplyParams;
        if (edit.operation.startsWith("paste-") && edit.clipboardVersion === undefined) {
          const clipboard = await client.call("edit.state");
          edit.clipboardVersion = clipboard.version;
          cancelled();
        }
        options.onProgress?.({ completed, total: chain.operations.length, committing: true });
        result = await client.call("edit.apply", edit);
      } else {
        let job: ProcessJobResult;
        if (op.method === CHAIN_SPEECH_GENERATE) {
          const { documentId, start, end, channelMask, levelDb, ...speech } =
            params as SpeechGenerateParams;
          const synthesized = await (options.synthesize ?? workerSynthesizer)(
            speech,
            options.signal,
          );
          cancelled();
          // Placed like Generate audio: insert at a cursor, replace a selection.
          job = await client.startAudioProcess(
            {
              documentId,
              start,
              end,
              channelMask,
              operation: "generate",
              generator: "audio",
              sourceSampleRate: synthesized.sampleRate,
              ...(levelDb === undefined ? {} : { levelDb }),
            },
            synthesized.pcm,
          );
        } else
          job =
            op.method === "process.start"
              ? await client.call(op.method, params as ProcessStartParams)
              : await client.call(op.method, params as EffectPreviewParams);
        const jobParams = { documentId: info.documentId, jobId: job.jobId };
        const cancel = () => {
          void client.call("process.cancel", jobParams).catch(() => {});
        };
        options.signal?.addEventListener("abort", cancel, { once: true });
        try {
          cancelled();
          const ready =
            job.state === "running"
              ? await client.runProcess(jobParams, (job) =>
                  options.onProgress?.({ completed, total: chain.operations.length, job }),
                )
              : job;
          cancelled();
          if (ready.state !== "ready") throw new Error(`Unexpected job state: ${ready.state}`);
          options.onProgress?.({
            completed,
            total: chain.operations.length,
            job: ready,
            committing: true,
          });
          // A sent commit is authoritative even if cancellation arrives meanwhile.
          options.signal?.removeEventListener("abort", cancel);
          result = await client.call("process.commit", jobParams);
        } finally {
          options.signal?.removeEventListener("abort", cancel);
          await client.call("process.cancel", jobParams).catch(() => {});
        }
      }
      options.onEdited(result, info.documentId);
      info = result.document;
      completed++;
      options.onProgress?.({ completed, total: chain.operations.length });
    }
    return completed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Macro stopped after ${completed} of ${chain.operations.length} operations: ${message}. ${options.failureContext ?? "Completed changes remain in history; use Undo to revert them."}`,
    );
  }
}
