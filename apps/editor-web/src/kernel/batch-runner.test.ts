import type { DocumentInfoResult, OperationChain } from "@aae/protocol";
import { expect, it, vi } from "vitest";
import type { BatchDestination } from "@/lib/batch-output";
import { DEFAULT_BATCH_SETTINGS } from "@/lib/batch-settings";
import { runBatch } from "./batch-runner";
import type { KernelClient } from "./client";
import type { KernelRuntime } from "./runtime";

const chain: OperationChain = {
  version: 1,
  operations: [{ method: "process.start", range: "document", params: { operation: "reverse" } }],
};
function file(name: string, bytes = new TextEncoder().encode("RIFFstub").buffer): File {
  return { name, size: bytes.byteLength, arrayBuffer: async () => bytes } as File;
}
function destination(): BatchDestination {
  return { mode: "folder", label: "Results", preflight: vi.fn(), write: vi.fn() };
}
function session(id: number, fail?: "open" | "process") {
  const info: DocumentInfoResult = {
    documentId: `source-${id}`,
    name: `input-${id}.wav`,
    frames: 48,
    sampleRate: 48000,
    channels: 2,
    bitDepth: 16,
    float: false,
  };
  const final = { ...info, documentId: `edited-${id}` };
  const ready = { jobId: `job-${id}`, state: "ready", phase: "complete" };
  const client = {
    openDocument: vi.fn(async () => {
      if (fail === "open") throw new Error("damaged input");
      return info;
    }),
    call: vi.fn(async (method: string) => {
      if (method === "process.start") return { ...ready, state: "running" };
      if (method === "process.commit") {
        if (fail === "process") throw new Error("cannot commit");
        return { document: final };
      }
      if (method === "process.cancel") return;
      if (method === "doc.export")
        return {
          name: `${id}.flac`,
          mimeType: "audio/flac",
          dataBytes: 4,
          data: Uint8Array.of(id, 1, 2, 3).buffer,
        };
      throw new Error(`Unexpected RPC ${method}`);
    }),
    runProcess: vi.fn(async (_params, report) => {
      report({ ...ready, state: "running", phase: "reverse" });
      return ready;
    }),
    terminate: vi.fn(),
  };
  return { client, runtime: { client: client as unknown as KernelClient } as KernelRuntime };
}

it("uses fresh engines, tracks rotated document IDs and writes kernel bytes sequentially", async () => {
  const sessions = [session(1), session(2)];
  const createRuntime = vi.fn(async () => sessions[createRuntime.mock.calls.length - 1].runtime);
  const target = destination();
  const progress = vi.fn();
  await runBatch([file("one.wav"), file("two.wav")], chain, DEFAULT_BATCH_SETTINGS, target, {
    createRuntime,
    onProgress: progress,
  });
  expect(target.preflight).toHaveBeenCalledWith(["one-processed.flac", "two-processed.flac"]);
  expect(createRuntime).toHaveBeenCalledTimes(2);
  for (let index = 0; index < sessions.length; index++) {
    const { client } = sessions[index];
    expect(client.call).toHaveBeenCalledWith("process.start", {
      documentId: `source-${index + 1}`,
      operation: "reverse",
      start: 0,
      end: 48,
      channelMask: 3,
    });
    expect(client.call).toHaveBeenCalledWith("doc.export", {
      documentId: `edited-${index + 1}`,
      format: "flac",
      bitDepth: 16,
      float: false,
      scope: "document",
      dither: "none",
      noiseShaping: "none",
    });
    expect(client.terminate).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(target.write).mock.calls[index][0];
    expect(Array.from(new Uint8Array(saved.data))).toEqual([index + 1, 1, 2, 3]);
  }
  expect(progress).toHaveBeenCalledWith({
    index: 0,
    state: "Processing",
    completed: 0,
    total: 1,
    phase: "reverse",
  });
  expect(progress).toHaveBeenLastCalledWith({ index: 1, state: "Done" });
});

it("continues after failed imports and chain commits, exporting only successful files", async () => {
  const sessions = [session(1, "open"), session(2, "process"), session(3)];
  const createRuntime = vi.fn(async () => sessions[createRuntime.mock.calls.length - 1].runtime);
  const target = destination();
  const progress = vi.fn();
  await runBatch(
    [file("bad.wav"), file("failed.wav"), file("ok.wav")],
    chain,
    DEFAULT_BATCH_SETTINGS,
    target,
    {
      createRuntime,
      onProgress: progress,
    },
  );
  expect(target.write).toHaveBeenCalledTimes(1);
  expect(vi.mocked(target.write).mock.calls[0][0].name).toBe("ok-processed.flac");
  expect(sessions[0].client.call).not.toHaveBeenCalled();
  expect(sessions[1].client.call.mock.calls.some(([method]) => method === "doc.export")).toBe(
    false,
  );
  expect(progress).toHaveBeenCalledWith(
    expect.objectContaining({ index: 0, state: "Failed", error: "damaged input" }),
  );
  expect(progress).toHaveBeenCalledWith(
    expect.objectContaining({
      index: 1,
      state: "Failed",
      error: expect.stringContaining("cannot commit"),
    }),
  );
  for (const { client } of sessions) expect(client.terminate).toHaveBeenCalledTimes(1);
  const failure = progress.mock.calls.find(
    ([row]) => row.index === 1 && row.state === "Failed",
  )?.[0];
  expect(failure.error).toContain("This file was skipped; no output was saved.");
  expect(failure.error).not.toContain("Undo");
});

it("cancels a pending import and skips unopened files without exporting", async () => {
  const abort = new AbortController();
  const { client, runtime } = session(1);
  client.openDocument.mockImplementation(async () => {
    abort.abort();
    return {} as DocumentInfoResult;
  });
  const createRuntime = vi.fn(async () => runtime);
  const progress = vi.fn();
  const target = destination();
  await runBatch([file("one.wav"), file("two.wav")], chain, DEFAULT_BATCH_SETTINGS, target, {
    signal: abort.signal,
    createRuntime,
    onProgress: progress,
  });
  expect(client.terminate).toHaveBeenCalledTimes(2);
  expect(client.call).not.toHaveBeenCalled();
  expect(target.write).not.toHaveBeenCalled();
  expect(createRuntime).toHaveBeenCalledTimes(1);
  expect(progress).toHaveBeenCalledWith({ index: 0, state: "Cancelled" });
  expect(progress).toHaveBeenLastCalledWith({ index: 1, state: "Cancelled" });
});

it("keeps an authoritative save when cancelled and never opens subsequent files", async () => {
  const abort = new AbortController();
  const { client, runtime } = session(1);
  const target = destination();
  target.write = vi.fn(async () => abort.abort());
  const progress = vi.fn();
  const createRuntime = vi.fn(async () => runtime);
  await runBatch(
    [file("one.wav"), file("two.wav")],
    { version: 1, operations: [] },
    DEFAULT_BATCH_SETTINGS,
    target,
    {
      signal: abort.signal,
      createRuntime,
      onProgress: progress,
    },
  );
  expect(target.write).toHaveBeenCalledTimes(1);
  expect(createRuntime).toHaveBeenCalledTimes(1);
  expect(client.terminate).toHaveBeenCalledTimes(2);
  expect(progress).toHaveBeenCalledWith({ index: 0, state: "Done" });
  expect(progress).toHaveBeenLastCalledWith({ index: 1, state: "Cancelled" });
});

it("preflights names, settings and existing destinations before any engine is created", async () => {
  const target = destination();
  const createRuntime = vi.fn();
  const options = { createRuntime, onProgress: vi.fn() };
  await expect(
    runBatch([file("same.wav"), file("Same.aiff")], chain, DEFAULT_BATCH_SETTINGS, target, options),
  ).rejects.toThrow("Duplicate");
  await expect(
    runBatch(
      [file("valid.wav")],
      chain,
      { ...DEFAULT_BATCH_SETTINGS, suffix: "/escape" },
      target,
      options,
    ),
  ).rejects.toThrow("suffix");
  await expect(
    runBatch(
      [file("valid.wav")],
      chain,
      { ...DEFAULT_BATCH_SETTINGS, bitDepth: 32 },
      target,
      options,
    ),
  ).rejects.toThrow("bit depth");
  expect(target.preflight).not.toHaveBeenCalled();
  target.preflight = vi.fn(async () => {
    throw new Error("Output already exists");
  });
  await expect(
    runBatch([file("valid.wav")], chain, DEFAULT_BATCH_SETTINGS, target, options),
  ).rejects.toThrow("already exists");
  expect(createRuntime).not.toHaveBeenCalled();
  expect(target.write).not.toHaveBeenCalled();
});

it("does not boot for oversized files and reports write failures separately", async () => {
  const { runtime, client } = session(1);
  const createRuntime = vi.fn(async () => runtime);
  const target = destination();
  target.write = vi.fn(async () => {
    throw new Error("disk full");
  });
  const huge = { ...file("huge.wav"), size: 129 * 1024 * 1024 } as File;
  const progress = vi.fn();
  await runBatch(
    [huge, file("save.wav")],
    { version: 1, operations: [] },
    DEFAULT_BATCH_SETTINGS,
    target,
    { createRuntime, onProgress: progress },
  );
  expect(createRuntime).toHaveBeenCalledTimes(1);
  expect(progress).toHaveBeenCalledWith(
    expect.objectContaining({
      index: 0,
      state: "Failed",
      error: expect.stringContaining("128 MiB"),
    }),
  );
  expect(progress).toHaveBeenLastCalledWith({ index: 1, state: "Failed", error: "disk full" });
  expect(client.terminate).toHaveBeenCalledTimes(1);
});
