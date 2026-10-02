import type { DocumentMemoryResult } from "@aae/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelClient, type WorkerLike } from "@/kernel/client";
import type { WorkerReply, WorkerRequest } from "@/kernel/messages";
import { useDocumentMemory } from "./use-document-memory";

class MemoryWorker implements WorkerLike {
  sent: WorkerRequest[] = [];
  private listener?: (event: MessageEvent<WorkerReply>) => void;

  postMessage(message: WorkerRequest) {
    this.sent.push(message);
  }

  addEventListener(_type: "message", listener: (event: MessageEvent<WorkerReply>) => void) {
    this.listener = listener;
  }

  terminate() {}

  reply(index: number, memory: DocumentMemoryResult) {
    this.listener?.({
      data: { kind: "reply", id: this.sent[index].id, ok: true, result: memory },
    } as MessageEvent<WorkerReply>);
  }

  fail(index: number) {
    this.listener?.({
      data: { kind: "reply", id: this.sent[index].id, ok: false, error: "unavailable" },
    } as MessageEvent<WorkerReply>);
  }
}

const emptyMemory: DocumentMemoryResult = {
  sampleBytes: 0,
  uniqueBlocks: 0,
  blockReferences: 0,
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useDocumentMemory", () => {
  it("waits for a client and refreshes memory after each completed request", async () => {
    const worker = new MemoryWorker();
    const client = new KernelClient(worker);
    const initialProps: { client: KernelClient | undefined } = { client: undefined };
    const { result, rerender } = renderHook(
      ({ client }: { client: KernelClient | undefined }) => useDocumentMemory(client),
      { initialProps },
    );
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(result.current).toBeUndefined();
    expect(worker.sent).toHaveLength(0);

    rerender({ client });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(worker.sent[0]).toMatchObject({ op: "call", method: "doc.memory" });
    await act(async () => worker.reply(0, emptyMemory));
    expect(result.current).toEqual(emptyMemory);

    await act(() => vi.advanceTimersByTimeAsync(1_000));
    const memory = { sampleBytes: 16384, uniqueBlocks: 1, blockReferences: 2 };
    await act(async () => worker.reply(1, memory));
    expect(result.current).toEqual(memory);
  });

  it("does not overlap slow requests, including the initial StrictMode mount", async () => {
    const worker = new MemoryWorker();
    const client = new KernelClient(worker);
    renderHook(() => useDocumentMemory(client), { wrapper: StrictMode });
    await act(() => vi.advanceTimersByTimeAsync(4_000));
    expect(worker.sent).toHaveLength(1);
    await act(async () => worker.reply(0, emptyMemory));
    await act(() => vi.advanceTimersByTimeAsync(999));
    expect(worker.sent).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(worker.sent).toHaveLength(2);
  });

  it("ignores a previous client's late response and hides its memory immediately", async () => {
    const oldWorker = new MemoryWorker();
    const oldClient = new KernelClient(oldWorker);
    const newWorker = new MemoryWorker();
    const newClient = new KernelClient(newWorker);
    const { result, rerender } = renderHook(({ client }) => useDocumentMemory(client), {
      initialProps: { client: oldClient },
    });
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(async () => oldWorker.reply(0, { ...emptyMemory, sampleBytes: 1024 }));
    await act(() => vi.advanceTimersByTimeAsync(1_000));

    rerender({ client: newClient });
    expect(result.current).toBeUndefined();
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(async () => newWorker.reply(0, emptyMemory));
    await act(async () => oldWorker.reply(1, { ...emptyMemory, sampleBytes: 2048 }));
    expect(result.current).toEqual(emptyMemory);
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(oldWorker.sent).toHaveLength(2);
    expect(newWorker.sent).toHaveLength(2);
  });

  it("clears unavailable memory and retries after a rejected request", async () => {
    const worker = new MemoryWorker();
    const client = new KernelClient(worker);
    const { result } = renderHook(() => useDocumentMemory(client));
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(async () => worker.reply(0, emptyMemory));
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    await act(async () => worker.fail(1));
    expect(result.current).toBeUndefined();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    await act(async () => worker.reply(2, emptyMemory));
    expect(result.current).toEqual(emptyMemory);
  });

  it("does not schedule new requests after unmount, even when a reply arrives late", async () => {
    const worker = new MemoryWorker();
    const client = new KernelClient(worker);
    const { unmount } = renderHook(() => useDocumentMemory(client));
    await act(() => vi.advanceTimersByTimeAsync(0));
    unmount();
    await act(async () => worker.reply(0, emptyMemory));
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(worker.sent).toHaveLength(1);
  });
});
