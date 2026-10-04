import type { OperationChain } from "@aae/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { BatchDestination } from "@/lib/batch-output";
import { useBatch } from "./use-batch";

const fakes = vi.hoisted(() => ({ run: vi.fn(), folder: vi.fn() }));
vi.mock("@/kernel/batch-runner", () => ({ runBatch: fakes.run }));
vi.mock("@/lib/batch-output", () => ({
  chooseBatchDirectory: fakes.folder,
  batchDownloads: () => ({ mode: "downloads", label: "Browser downloads" }),
}));
const chain: OperationChain = {
  version: 1,
  operations: [{ method: "process.start", range: "document", params: { operation: "reverse" } }],
};
const file = { name: "voice.wav" } as File;
function directory(name: string): BatchDestination {
  return {
    mode: "folder",
    label: name,
    write: vi.fn(),
    preflight: vi.fn(),
    dispose: vi.fn(async () => {}),
  };
}
afterEach(() => {
  cleanup();
  fakes.run.mockReset();
  fakes.folder.mockReset();
});

it("opens with the current macro, imports bounded chains and preserves it on invalid imports", async () => {
  const { result } = renderHook(() => useBatch(chain));
  act(() => result.current.show());
  expect(result.current.open).toBe(true);
  expect(result.current.chain).toEqual(chain);
  expect(result.current.chain).not.toBe(chain);
  await act(async () => result.current.load({ size: 6, text: async () => "broken" } as File));
  expect(result.current.error).toBeTruthy();
  expect(result.current.chain).toEqual(chain);
  await act(async () => result.current.load({ size: 2 * 1024 * 1024 } as File));
  expect(result.current.error).toContain("1 MiB");
  const empty = { version: 1, operations: [] };
  await act(async () =>
    result.current.load({ size: 32, text: async () => JSON.stringify(empty) } as File),
  );
  expect(result.current.chain.operations).toHaveLength(0);
  act(() => result.current.chooseMacro());
  expect(result.current.chain).toEqual(chain);
  act(() => result.current.clearChain());
  expect(result.current.chain.operations).toHaveLength(0);
});

it("fences configuration and batch start during asynchronous imports", async () => {
  const { result } = renderHook(() => useBatch(chain));
  act(() => result.current.selectFiles([file]));
  let finish: ((text: string) => void) | undefined;
  const text = new Promise<string>((resolve) => {
    finish = resolve;
  });
  let loading: Promise<void> | undefined;
  act(() => {
    loading = result.current.load({ size: 32, text: () => text } as File);
  });
  expect(result.current.working).toBe(true);
  act(() => {
    result.current.selectFiles([]);
    result.current.changeSettings({ suffix: "changed" });
    void result.current.start();
  });
  expect(result.current.files).toEqual([file]);
  expect(result.current.settings.suffix).toBe("-processed");
  expect(fakes.run).not.toHaveBeenCalled();
  await act(async () => {
    finish?.(JSON.stringify(chain));
    await loading;
  });
  expect(result.current.working).toBe(false);
});

it("rejects duplicate names before running and exposes per-file progress", async () => {
  const { result } = renderHook(() => useBatch(chain));
  act(() => result.current.selectFiles([file, { name: "voice.flac" } as File]));
  await act(async () => result.current.start());
  expect(result.current.error).toContain("Duplicate");
  expect(fakes.run).not.toHaveBeenCalled();
  act(() => result.current.selectFiles([file]));
  fakes.run.mockImplementation(async (_files, _chain, _settings, _target, options) => {
    options.onProgress({ index: 0, state: "Done" });
  });
  await act(async () => result.current.start());
  expect(result.current.error).toBeUndefined();
  expect(result.current.finished).toBe(true);
  expect(result.current.progress).toEqual([{ index: 0, state: "Done" }]);
  expect(fakes.run).toHaveBeenCalledWith(
    [file],
    { version: 1, operations: [] },
    expect.objectContaining({ format: "flac", bitDepth: 16 }),
    expect.objectContaining({ mode: "downloads" }),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

it("aborts on cancel or unmount, retains output grants until active saves settle", async () => {
  const target = directory("Results");
  fakes.folder.mockResolvedValue(target);
  const { result, unmount } = renderHook(() => useBatch(chain));
  await act(async () => result.current.chooseFolder());
  act(() => {
    result.current.selectFiles([file]);
    result.current.show();
  });
  let finish: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  fakes.run.mockImplementation(async (_files, _chain, _settings, _target, options) => {
    signal = options.signal;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  let running: Promise<void> | undefined;
  act(() => {
    running = result.current.start();
  });
  expect(result.current.running).toBe(true);
  act(() => {
    result.current.close();
    result.current.selectFiles([]);
    result.current.cancel();
  });
  expect(result.current.open).toBe(true);
  expect(result.current.files).toEqual([file]);
  expect(signal?.aborted).toBe(true);
  unmount();
  expect(target.dispose).not.toHaveBeenCalled();
  await act(async () => {
    finish?.();
    await running;
  });
  expect(target.dispose).toHaveBeenCalledTimes(1);
});

it("releases replaced folder grants and leaves the previous choice after picker cancellation", async () => {
  const first = directory("First");
  const second = directory("Second");
  fakes.folder
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(second);
  const { result, unmount } = renderHook(() => useBatch(chain));
  await act(async () => result.current.chooseFolder());
  await act(async () => result.current.chooseFolder());
  expect(result.current.destination).toBe(first);
  expect(first.dispose).not.toHaveBeenCalled();
  await act(async () => result.current.chooseFolder());
  expect(first.dispose).toHaveBeenCalledTimes(1);
  expect(result.current.destination).toBe(second);
  unmount();
  expect(second.dispose).toHaveBeenCalledTimes(1);
});
