import type { MetadataResult } from "@aae/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { KernelClient } from "@/kernel/client";
import { useMetadata } from "./use-metadata";

const info = {
  documentId: "doc",
  name: "tagged.wav",
  sampleRate: 48000,
  channels: 1,
  frames: 4,
  bitDepth: 32,
  float: true,
};
const metadata: MetadataResult = {
  documentId: "doc",
  stateId: "state",
  tags: { title: "Original" },
  preservedBytes: 10,
  chunks: ["LIST/INFO"],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const call = vi.fn().mockResolvedValue(metadata);
  const onChanged = vi.fn();
  const withOperation = vi.fn(async (work: () => Promise<void>) => work());
  const options = {
    client: { call } as unknown as KernelClient,
    info,
    stateId: "state",
    busy: false,
    onChanged,
    withOperation,
  };
  return {
    ...renderHook((props) => useMetadata(props), { initialProps: options }),
    options,
    call,
    onChanged,
    withOperation,
  };
}
afterEach(cleanup);
it("reads only on demand and commits one guarded metadata request under the shared lock", async () => {
  const f = fixture();
  expect(f.call).not.toHaveBeenCalled();
  act(() => f.result.current.open());
  await waitFor(() => expect(f.result.current.view?.metadata).toEqual(metadata));
  const saving = deferred<unknown>();
  f.call.mockReturnValue(saving.promise);
  let pending: Promise<void> | undefined;
  act(() => {
    pending = f.result.current.commit({ title: "New" });
  });
  expect(f.withOperation).toHaveBeenCalledOnce();
  expect(f.call).toHaveBeenLastCalledWith("metadata.set", {
    documentId: "doc",
    stateId: "state",
    tags: { title: "New" },
  });
  act(() => f.result.current.cancel());
  expect(f.result.current.view?.committing).toBe(true);
  await act(async () => {
    await f.result.current.commit({ title: "Duplicate" });
  });
  expect(f.call).toHaveBeenCalledTimes(2);
  const history = { currentStateId: "new" };
  await act(async () => {
    saving.resolve({ ...metadata, history, changed: true });
    await pending;
  });
  expect(f.onChanged).toHaveBeenCalledWith(history);
  expect(f.result.current.view).toBeUndefined();
  expect(f.call.mock.calls.map(([method]) => method)).toEqual(["metadata.get", "metadata.set"]);
});
it("ignores cancelled, replaced-client and replaced-history reads", async () => {
  const f = fixture();
  const first = deferred<MetadataResult>();
  f.call.mockReturnValue(first.promise);
  act(() => f.result.current.open());
  act(() => f.result.current.cancel());
  await act(async () => first.resolve(metadata));
  expect(f.result.current.view).toBeUndefined();
  const second = deferred<MetadataResult>();
  f.call.mockReturnValue(second.promise);
  act(() => f.result.current.open());
  f.rerender({ ...f.options, stateId: "other" });
  await act(async () => second.resolve(metadata));
  expect(f.result.current.view).toBeUndefined();
  act(() => f.result.current.open());
  f.rerender({ ...f.options, client: { call: vi.fn() } as unknown as KernelClient });
  await act(async () => Promise.resolve());
  expect(f.result.current.view).toBeUndefined();
  expect(f.onChanged).not.toHaveBeenCalled();
});
it("keeps failed drafts retryable and shows mismatched reads as errors", async () => {
  const f = fixture();
  f.call.mockResolvedValue({ ...metadata, stateId: "stale" });
  act(() => f.result.current.open());
  await waitFor(() => expect(f.result.current.view?.error).toMatch(/Document changed/));
  act(() => f.result.current.cancel());
  f.call.mockResolvedValue(metadata);
  act(() => f.result.current.open());
  await waitFor(() => expect(f.result.current.view?.metadata).toEqual(metadata));
  f.call.mockRejectedValue(new Error("Tags exceed the budget"));
  await act(async () => f.result.current.commit({ title: "Large" }));
  expect(f.result.current.view).toMatchObject({
    working: false,
    committing: false,
    error: "Tags exceed the budget",
    metadata,
  });
  expect(f.onChanged).not.toHaveBeenCalled();
  f.call.mockResolvedValue({ ...metadata, history: {}, changed: false });
  await act(async () => f.result.current.commit(metadata.tags));
  expect(f.result.current.view).toBeUndefined();
});
it("discards a commit reply after replacement and fences busy opening/commits", async () => {
  const f = fixture();
  f.rerender({ ...f.options, busy: true });
  act(() => f.result.current.open());
  expect(f.call).not.toHaveBeenCalled();
  f.rerender(f.options);
  act(() => f.result.current.open());
  await waitFor(() => expect(f.result.current.view?.metadata).toEqual(metadata));
  f.rerender({ ...f.options, busy: true });
  await act(async () => f.result.current.commit(metadata.tags));
  expect(f.call).toHaveBeenCalledTimes(1);
  f.rerender(f.options);
  const saving = deferred<unknown>();
  f.call.mockReturnValue(saving.promise);
  let pending: Promise<void> | undefined;
  act(() => {
    pending = f.result.current.commit({ title: "New" });
  });
  f.rerender({ ...f.options, info: { ...info, documentId: "other" } });
  await act(async () => {
    saving.resolve({ ...metadata, history: {} });
    await pending;
  });
  expect(f.onChanged).not.toHaveBeenCalled();
  expect(f.result.current.view).toBeUndefined();
});
