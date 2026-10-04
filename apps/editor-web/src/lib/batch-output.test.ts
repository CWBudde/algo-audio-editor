import type { ExportResult } from "@aae/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { batchDownloads, chooseBatchDirectory } from "./batch-output";

const state = vi.hoisted(() => ({ bridge: undefined as unknown }));
vi.mock("@/platform", () => ({ desktopBridge: () => state.bridge }));
const result: ExportResult = {
  name: "voice.flac",
  mimeType: "audio/flac",
  data: Uint8Array.of(1, 2, 3).buffer,
  dataBytes: 3,
};
afterEach(() => {
  state.bridge = undefined;
  delete window.showDirectoryPicker;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("preflights and rechecks browser folder outputs, writing final kernel bytes", async () => {
  const writable = { write: vi.fn(), close: vi.fn(), abort: vi.fn(async () => {}) };
  const getFileHandle = vi.fn(async (_name: string, options: { create: boolean }) => {
    if (!options.create) throw new DOMException("Absent", "NotFoundError");
    return { createWritable: async () => writable };
  });
  window.showDirectoryPicker = vi.fn(async () => ({ name: "Results", getFileHandle }));
  const target = await chooseBatchDirectory();
  expect(target?.label).toBe("Results");
  expect(window.showDirectoryPicker).toHaveBeenCalledWith({ mode: "readwrite" });
  await target?.preflight([result.name]);
  await target?.write(result);
  expect(getFileHandle.mock.calls.map(([, options]) => options.create)).toEqual([
    false,
    false,
    true,
  ]);
  expect(writable.write).toHaveBeenCalledWith(expect.any(Blob));
  expect(writable.close).toHaveBeenCalledTimes(1);
  expect(writable.abort).not.toHaveBeenCalled();
  getFileHandle.mockImplementation(async () => ({ createWritable: async () => writable }));
  await expect(target?.preflight([result.name])).rejects.toThrow("already exists");
  await expect(target?.write(result)).rejects.toThrow("already exists");
  expect(writable.write).toHaveBeenCalledTimes(1);
});

it("aborts a failed browser write and propagates permission and picker failures", async () => {
  const writable = {
    write: vi.fn(async () => {
      throw new Error("disk full");
    }),
    close: vi.fn(),
    abort: vi.fn(async () => {}),
  };
  window.showDirectoryPicker = vi.fn(async () => ({
    name: "Results",
    async getFileHandle(_name: string, options: { create: boolean }) {
      if (!options.create) throw new DOMException("Absent", "NotFoundError");
      return { createWritable: async () => writable };
    },
  }));
  const target = await chooseBatchDirectory();
  await expect(target?.write(result)).rejects.toThrow("disk full");
  expect(writable.abort).toHaveBeenCalledTimes(1);
  expect(writable.close).not.toHaveBeenCalled();
  window.showDirectoryPicker = vi.fn(async () => {
    throw new DOMException("Cancelled", "AbortError");
  });
  expect(await chooseBatchDirectory()).toBeUndefined();
  window.showDirectoryPicker = vi.fn(async () => {
    throw new DOMException("Blocked", "NotAllowedError");
  });
  await expect(chooseBatchDirectory()).rejects.toThrow("Blocked");
});

it("routes desktop output solely through the selected directory grant and releases it", async () => {
  const bridge = {
    pickBatchDirectory: vi.fn(async () => ({ id: "grant-1", name: "Results" })),
    writeBatchFile: vi.fn(),
    releaseBatchDirectory: vi.fn(),
  };
  state.bridge = bridge;
  window.showDirectoryPicker = vi.fn();
  const target = await chooseBatchDirectory();
  await target?.preflight([result.name]);
  await target?.write(result);
  await target?.dispose?.();
  expect(bridge.writeBatchFile).toHaveBeenCalledWith("grant-1", result.name, result.data);
  expect(bridge.releaseBatchDirectory).toHaveBeenCalledWith("grant-1");
  expect(window.showDirectoryPicker).not.toHaveBeenCalled();
});

it("requests downloads with the chosen names and revokes blob URLs", async () => {
  vi.useFakeTimers();
  const create = vi.fn(() => "blob:batch-output");
  const revoke = vi.fn();
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
  const clicked: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push(this.download);
  });
  const target = batchDownloads();
  await target.write(result);
  expect(clicked).toEqual([result.name]);
  expect(create).toHaveBeenCalledWith(expect.any(Blob));
  expect(document.querySelector("a[download]")).toBeNull();
  vi.advanceTimersByTime(1000);
  expect(revoke).toHaveBeenCalledWith("blob:batch-output");
});
