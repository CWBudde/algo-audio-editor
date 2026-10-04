import type { AnalysisJobResult, AnalysisStartParams } from "@aae/protocol";
import type { KernelClient } from "./client";

const queues = new WeakMap<KernelClient, Promise<unknown>>();
const reservations = new WeakMap<KernelClient, Map<string, () => void>>();
/** Release after authoritative commit/cancellation has vacated the kernel slot. */
export function releaseAnalysis(client: KernelClient, jobId: string): void {
  const owned = reservations.get(client);
  owned?.get(jobId)?.();
  owned?.delete(jobId);
}
/** Serializes the single kernel analysis slot while keeping playback independent. */
export function analyse(
  client: KernelClient,
  params: AnalysisStartParams,
  signal: AbortSignal,
  progress?: (job: AnalysisJobResult) => void,
): Promise<AnalysisJobResult> {
  const previous = queues.get(client) ?? Promise.resolve();
  const work = previous
    .catch(() => {})
    .then(async () => {
      if (signal.aborted) throw new DOMException("Analysis cancelled", "AbortError");
      let job: AnalysisJobResult | undefined;
      try {
        job = await client.call("analysis.start", params);
        if (signal.aborted) throw new DOMException("Analysis cancelled", "AbortError");
        if (job.state === "running")
          job = await client.runAnalysis(
            { documentId: job.documentId, jobId: job.jobId },
            progress,
            signal,
          );
        if (signal.aborted || job.state === "cancelled")
          throw new DOMException("Analysis cancelled", "AbortError");
        return job;
      } finally {
        if (job && (params.kind !== "clipping" || signal.aborted || job.state !== "ready"))
          await client
            .call("analysis.cancel", { documentId: job.documentId, jobId: job.jobId })
            .catch(() => {});
      }
    });
  queues.set(
    client,
    work.then(
      (job) => {
        if (params.kind !== "clipping") return;
        return new Promise<void>((resolve) => {
          let owned = reservations.get(client);
          if (!owned) {
            owned = new Map();
            reservations.set(client, owned);
          }
          owned.set(job.jobId, resolve);
        });
      },
      () => undefined,
    ),
  );
  return work;
}
