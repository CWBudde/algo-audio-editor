import type { DocumentInfoResult, ProcessJobResult } from "@aae/protocol";
import type { KernelClient } from "@/kernel/client";

export function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export interface JobLease {
  done: ReturnType<typeof deferred>;
  released: ReturnType<typeof deferred>;
}

/** Keep the document fence until the UI commits/cancels and cleanup completes. */
export function holdJobLock(
  lease: JobLease,
  withOperation: (work: () => Promise<void>) => Promise<void>,
  acquire: () => void | Promise<void>,
  failed: (error: unknown) => void,
  settled: () => void = () => {},
) {
  void withOperation(async () => {
    await acquire();
    await lease.done.promise;
  })
    .catch(failed)
    .finally(() => {
      settled();
      lease.released.resolve();
    });
}

export async function releaseJobLock(lease: JobLease) {
  lease.done.resolve();
  await lease.released.promise;
}

/** Both processing dialogs use the same worker run/progress identity contract. */
export async function runCandidate(
  client: KernelClient,
  info: DocumentInfoResult,
  job: ProcessJobResult,
  onProgress: (job: ProcessJobResult) => void,
): Promise<ProcessJobResult> {
  if (job.state !== "running") return job;
  return client.runProcess({ documentId: info.documentId, jobId: job.jobId }, (progress) => {
    if (progress.jobId === job.jobId && progress.documentId === info.documentId)
      onProgress(progress);
  });
}
