import type {
  DocumentInfoResult,
  EditResult,
  OperationChain,
  ProcessJobResult,
} from "@aae/protocol";
import { expect, it, vi } from "vitest";
import { runOperationChain } from "./chain-runner";
import type { KernelClient } from "./client";

const info: DocumentInfoResult = {
  documentId: "doc-1",
  name: "test.wav",
  frames: 100,
  channels: 2,
  sampleRate: 48000,
  bitDepth: 16,
  float: false,
};
const edit = (document: DocumentInfoResult) =>
  ({
    document,
    changed: true,
    selection: {
      documentId: document.documentId,
      start: 0,
      end: document.frames,
      channelMask: 2 ** document.channels - 1,
    },
  }) as EditResult;
const job = { jobId: "job-1", state: "running" } as ProcessJobResult;
const chain: OperationChain = {
  version: 1,
  operations: [
    { method: "edit.apply", params: { operation: "crop", start: 10, end: 60 } },
    { method: "process.start", range: "document", params: { operation: "reverse" } },
  ],
};
it("follows committed identities and geometry, publishes each edit and uses bounded jobs", async () => {
  const first = edit({ ...info, documentId: "doc-2", frames: 50 });
  const second = edit({ ...first.document, documentId: "doc-3" });
  const call = vi.fn(async (method: string) => {
    if (method === "selection.get") return { start: 5, end: 20, channelMask: 2 };
    if (method === "edit.apply") return first;
    if (method === "process.start") return job;
    if (method === "process.commit") return second;
    if (method === "process.cancel") return {};
    throw new Error(method);
  });
  const runProcess = vi.fn(async () => ({ ...job, state: "ready" }));
  const onEdited = vi.fn();
  expect(
    await runOperationChain({ call, runProcess } as unknown as KernelClient, info, chain, {
      onEdited,
    }),
  ).toBe(2);
  expect(call).toHaveBeenCalledWith("edit.apply", {
    documentId: "doc-1",
    start: 10,
    end: 60,
    channelMask: 2,
    operation: "crop",
  });
  expect(call).toHaveBeenCalledWith("process.start", {
    documentId: "doc-2",
    start: 0,
    end: 50,
    channelMask: 3,
    operation: "reverse",
  });
  expect(runProcess).toHaveBeenCalledWith(
    { documentId: "doc-2", jobId: "job-1" },
    expect.any(Function),
  );
  expect(onEdited.mock.calls).toEqual([
    [first, "doc-1"],
    [second, "doc-2"],
  ]);
});
it("binds recorded paste to the current clipboard, discards failed jobs and reports the completed prefix", async () => {
  const call = vi.fn(async (method: string) => {
    if (method === "selection.get") return { start: 0, end: 100, channelMask: 3 };
    if (method === "edit.state") return { version: "new-clipboard" };
    if (method === "edit.apply") return edit({ ...info, documentId: "doc-2" });
    if (method === "process.start") return job;
    return {};
  });
  const input: OperationChain = {
    version: 1,
    operations: [
      { method: "edit.apply", params: { operation: "paste-insert" } },
      chain.operations[1],
    ],
  };
  const onEdited = vi.fn();
  const runProcess = vi.fn(async () => {
    throw new Error("bad DSP parameter");
  });
  await expect(
    runOperationChain({ call, runProcess } as unknown as KernelClient, info, input, { onEdited }),
  ).rejects.toThrow("after 1 of 2");
  expect(call).toHaveBeenCalledWith(
    "edit.apply",
    expect.objectContaining({ clipboardVersion: "new-clipboard" }),
  );
  expect(call).toHaveBeenCalledWith("process.cancel", { documentId: "doc-2", jobId: "job-1" });
  expect(call.mock.calls.some(([method]) => method === "process.commit")).toBe(false);
  expect(onEdited).toHaveBeenCalledOnce();
});
it("cancels a private candidate and never sends its commit", async () => {
  const abort = new AbortController();
  const call = vi.fn(async (method: string) => (method === "process.start" ? job : {}));
  const runProcess = vi.fn(async () => {
    abort.abort();
    return { ...job, state: "ready" };
  });
  const onEdited = vi.fn();
  await expect(
    runOperationChain(
      { call, runProcess } as unknown as KernelClient,
      info,
      { version: 1, operations: [chain.operations[1]] },
      { signal: abort.signal, onEdited },
    ),
  ).rejects.toThrow("after 0 of 1");
  expect(call).toHaveBeenCalledWith("process.cancel", { documentId: "doc-1", jobId: "job-1" });
  expect(call.mock.calls.some(([method]) => method === "process.commit")).toBe(false);
  expect(onEdited).not.toHaveBeenCalled();
});
it("accepts an already sent commit after cancellation and stops before the next operation", async () => {
  const abort = new AbortController();
  const result = edit({ ...info, documentId: "doc-2" });
  const call = vi.fn(async (method: string) => {
    if (method === "process.start") return { ...job, state: "ready" };
    if (method === "process.commit") {
      abort.abort();
      return result;
    }
    return {};
  });
  const onEdited = vi.fn();
  await expect(
    runOperationChain(
      { call } as unknown as KernelClient,
      info,
      { version: 1, operations: [chain.operations[1], chain.operations[1]] },
      { signal: abort.signal, onEdited },
    ),
  ).rejects.toThrow("after 1 of 2");
  expect(onEdited).toHaveBeenCalledExactlyOnceWith(result, "doc-1");
  expect(call.mock.calls.filter(([method]) => method === "process.start")).toHaveLength(1);
});
it("rejects invalid later envelopes before executing the prefix", async () => {
  const call = vi.fn();
  const input = {
    version: 1,
    operations: [chain.operations[0], { method: "transport.play", params: {} }],
  } as unknown as OperationChain;
  await expect(
    runOperationChain({ call } as unknown as KernelClient, info, input, { onEdited: vi.fn() }),
  ).rejects.toThrow("edit.apply");
  expect(call).not.toHaveBeenCalled();
});
