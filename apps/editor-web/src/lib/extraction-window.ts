import type { BinaryDocumentResult, ProcessJobResult } from "@aae/protocol";
import type { KernelClient } from "@/kernel/client";
import { startKernel } from "@/kernel/runtime";

const parameter = "extract";
const timeoutMs = 60_000;
interface Reservation {
  child: Window;
  port: Promise<MessagePort>;
  signal: AbortSignal;
  abort(): void;
}
let reserved: Reservation | undefined;

/** Reserve under the Apply gesture, before kernel processing can yield. */
export function prepareExtractionWindow(): void {
  cancelExtractionWindow();
  const token = crypto.randomUUID();
  const url = new URL(window.location.href);
  url.searchParams.set(parameter, token);
  const child = window.open(url.href, `aae-extraction-${token}`);
  if (!child)
    throw new Error("The extraction window was blocked. Allow editor popups and try again.");
  let abort = () => {};
  const cancellation = new AbortController();
  const port = new Promise<MessagePort>((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener("message", ready);
      clearTimeout(timer);
      clearInterval(closed);
    };
    const fail = (message: string) => {
      cleanup();
      reject(new Error(message));
    };
    const ready = (event: MessageEvent) => {
      if (
        event.source !== child ||
        event.origin !== window.location.origin ||
        event.data?.type !== "aae.extraction.ready" ||
        event.data.token !== token
      )
        return;
      cleanup();
      const channel = new MessageChannel();
      try {
        child.postMessage({ type: "aae.extraction.connect", token }, window.location.origin, [
          channel.port2,
        ]);
        resolve(channel.port1);
      } catch (error) {
        channel.port1.close();
        channel.port2.close();
        reject(error);
      }
    };
    const timer = setTimeout(() => fail("The extraction window did not become ready."), timeoutMs);
    const closed = setInterval(() => {
      if (child.closed) fail("The extraction window was closed.");
    }, 250);
    abort = () => {
      cancellation.abort();
      fail("Channel extraction was cancelled.");
    };
    window.addEventListener("message", ready);
  });
  void port.catch(() => {});
  reserved = { child, port, abort, signal: cancellation.signal };
}

export function cancelExtractionWindow(): void {
  const pending = reserved;
  reserved = undefined;
  if (!pending) return;
  pending.abort();
  void pending.port.then(
    (port) => port.close(),
    () => {},
  );
  pending.child.close();
}

/** Commit only the destination window after it acknowledges a successful import. */
export async function openExtractedChannel(
  client: KernelClient,
  job: ProcessJobResult,
): Promise<void> {
  const pending = reserved;
  if (!pending) throw new Error("No extraction window is reserved.");
  const port = await pending.port;
  try {
    const result = await client.call("process.exportCandidate", {
      documentId: job.documentId,
      jobId: job.jobId,
    });
    if (reserved !== pending || pending.child.closed)
      throw new Error("Channel extraction was cancelled.");
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(closed);
        port.onmessage = null;
        port.onmessageerror = null;
        pending.signal.removeEventListener("abort", cancelled);
        if (error) reject(error);
        else resolve();
      };
      const cancelled = () => finish(new Error("Channel extraction was cancelled."));
      const timer = setTimeout(
        () => finish(new Error("The extraction import timed out.")),
        timeoutMs,
      );
      const closed = setInterval(() => {
        if (pending.child.closed) finish(new Error("The extraction window was closed."));
      }, 250);
      port.onmessage = (event: MessageEvent) => {
        if (reserved !== pending || pending.signal.aborted) return cancelled();
        if (event.data?.ok === true) finish();
        else finish(new Error(event.data?.error ?? "The extraction import failed."));
      };
      port.onmessageerror = () => finish(new Error("The extraction transfer failed."));
      pending.signal.addEventListener("abort", cancelled, { once: true });
      try {
        port.postMessage(result, [result.data]);
      } catch (error) {
        finish(error);
      }
    });
    if (reserved === pending) reserved = undefined;
  } finally {
    port.onmessage = null;
    port.onmessageerror = null;
    port.close();
  }
}

/** Import before mounting React so document hooks observe the new identity. */
export async function initializeExtractionWindow(): Promise<void> {
  const token = new URL(window.location.href).searchParams.get(parameter);
  if (!token) return;
  if (!window.opener || !/^[0-9a-f-]{36}$/i.test(token))
    throw new Error("Invalid extraction window.");
  const parent = window.opener as Window;
  const port = await new Promise<MessagePort>((resolve, reject) => {
    const connected = (event: MessageEvent) => {
      if (
        event.source !== parent ||
        event.origin !== window.location.origin ||
        event.data?.type !== "aae.extraction.connect" ||
        event.data.token !== token ||
        event.ports.length !== 1
      )
        return;
      clearTimeout(timer);
      window.removeEventListener("message", connected);
      resolve(event.ports[0]);
    };
    const timer = setTimeout(() => {
      window.removeEventListener("message", connected);
      reject(new Error("The source editor did not connect."));
    }, timeoutMs);
    window.addEventListener("message", connected);
    parent.postMessage({ type: "aae.extraction.ready", token }, window.location.origin);
  });
  try {
    const result = await new Promise<BinaryDocumentResult>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        port.onmessage = null;
        port.onmessageerror = null;
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("The source editor did not send audio."));
      }, timeoutMs);
      port.onmessage = (event: MessageEvent<BinaryDocumentResult>) => {
        cleanup();
        resolve(event.data);
      };
      port.onmessageerror = () => {
        cleanup();
        reject(new Error("The extraction transfer failed."));
      };
    });
    if (!(result.data instanceof ArrayBuffer) || result.data.byteLength !== result.dataBytes)
      throw new Error("Invalid extraction sample buffer.");
    const { data, dataBytes: _dataBytes, ...params } = result;
    const { client } = await startKernel();
    await client.importBinaryDocument(params, data);
    const url = new URL(window.location.href);
    url.searchParams.delete(parameter);
    window.history.replaceState(null, "", url);
    port.postMessage({ ok: true });
  } catch (error) {
    port.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    port.close();
  }
}
