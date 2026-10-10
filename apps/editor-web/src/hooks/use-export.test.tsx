import type { DocumentInfoResult, ExportResult } from "@aae/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { KernelClient } from "@/kernel/client";
import { chooseSaveTarget } from "@/lib/file-access";
import { encoderSupport, exportLossy } from "@/lib/lossy-export";
import { updatePreferences } from "@/lib/preferences";
import { useExport } from "./use-export";

vi.mock("@/lib/file-access", async (original) => ({
  ...(await original<typeof import("@/lib/file-access")>()),
  chooseSaveTarget: vi.fn(),
}));
vi.mock("@/lib/lossy-export", async (original) => ({
  ...(await original<typeof import("@/lib/lossy-export")>()),
  encoderSupport: vi.fn(async () => ({ opus: false, m4a: false })),
  exportLossy: vi.fn(),
}));
const info: DocumentInfoResult = {
  documentId: "doc-1",
  name: "song.WAV",
  channels: 2,
  frames: 100,
  sampleRate: 48000,
  bitDepth: 24,
  float: false,
};
const range = { start: 10, end: 30, channelMask: 2 };
const exported: ExportResult = {
  name: "song.wav",
  mimeType: "audio/wav",
  dataBytes: 4,
  data: new ArrayBuffer(4),
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  let locked = false;
  const call = vi.fn(async (method: string) =>
    method === "selection.get" ? { ...range, documentId: info.documentId } : exported,
  );
  const client = { call } as unknown as KernelClient;
  const onError = vi.fn();
  const withOperation = vi.fn(async (work: () => Promise<void>) => {
    if (locked) throw new Error("Another document operation is in progress.");
    locked = true;
    try {
      await work();
    } finally {
      locked = false;
    }
  });
  const write = vi.fn().mockResolvedValue(undefined);
  vi.mocked(chooseSaveTarget).mockResolvedValue({ write });
  const options = { client, info, withOperation, onError };
  return {
    ...renderHook((props) => useExport(props), { initialProps: options }),
    options,
    call,
    onError,
    write,
    withOperation,
    locked: () => locked,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(encoderSupport).mockResolvedValue({ opus: false, m4a: false });
});
afterEach(cleanup);

it("opens without a chooser or lock, and keeps the lock through writing a copy without marking saved", async () => {
  const f = fixture();
  const writing = deferred<void>();
  f.write.mockReturnValue(writing.promise);
  act(() => f.result.current.open(range));
  expect(chooseSaveTarget).not.toHaveBeenCalled();
  expect(f.withOperation).not.toHaveBeenCalled();
  let pending: Promise<void> | undefined;
  act(() => {
    pending = f.result.current.submit();
  });
  expect(chooseSaveTarget).toHaveBeenCalledWith("song.WAV", [
    { description: "WAV audio", accept: { "audio/wav": [".wav"] } },
  ]);
  expect(f.locked()).toBe(true);
  await act(async () => Promise.resolve());
  expect(f.result.current.view?.phase).toBe("exporting");
  expect(f.call).toHaveBeenCalledWith("doc.export", {
    documentId: "doc-1",
    format: "wav",
    bitDepth: 24,
    float: false,
    scope: "document",
    dither: "none",
    noiseShaping: "none",
  });
  expect(f.write).toHaveBeenCalledWith(exported);
  await expect(f.withOperation(async () => {})).rejects.toThrow("in progress");
  await act(async () => {
    writing.resolve();
    await pending;
  });
  expect(f.locked()).toBe(false);
  expect(f.result.current.view).toBeUndefined();
  expect(f.call.mock.calls.map(([method]) => method)).toEqual(["doc.export"]);
});
it("exports the selected time and channel snapshot with matching filename and quality settings", async () => {
  const f = fixture();
  act(() => f.result.current.open(range));
  act(() =>
    f.result.current.setSettings({
      scope: "selection",
      bitDepth: 16,
      dither: "triangular",
      noiseShaping: "9fc",
    }),
  );
  await act(async () => f.result.current.submit());
  expect(chooseSaveTarget).toHaveBeenCalledWith("song-selection.wav", [
    { description: "WAV audio", accept: { "audio/wav": [".wav"] } },
  ]);
  expect(f.call).toHaveBeenNthCalledWith(1, "selection.get", { documentId: "doc-1" });
  expect(f.call).toHaveBeenNthCalledWith(
    2,
    "doc.export",
    expect.objectContaining({
      scope: "selection",
      bitDepth: 16,
      dither: "triangular",
      noiseShaping: "9fc",
    }),
  );
});
it("defaults to TPDF dither when the chosen depth drops below the source's", async () => {
  const f = fixture();
  act(() => f.result.current.open(range));
  expect(f.result.current.view?.settings.dither).toBe("none");
  act(() => f.result.current.setSettings({ bitDepth: 16 }));
  expect(f.result.current.view?.settings.dither).toBe("triangular");
  await act(async () => f.result.current.submit());
  expect(f.call).toHaveBeenCalledWith(
    "doc.export",
    expect.objectContaining({ bitDepth: 16, dither: "triangular" }),
  );
});
it("opens with the preferred export format and dither", () => {
  updatePreferences({ exportFormat: "flac", exportDither: "rectangular" });
  const f = fixture();
  act(() => f.result.current.open(range));
  expect(f.result.current.view?.settings).toMatchObject({
    format: "flac",
    encoding: "pcm",
    bitDepth: 24,
    dither: "rectangular",
  });
});
it("clears integer quality settings on float format and keeps valid depth on switching back", () => {
  const f = fixture();
  act(() => f.result.current.open(range));
  act(() => f.result.current.setSettings({ dither: "gaussian", noiseShaping: "sharp" }));
  act(() => f.result.current.setSettings({ encoding: "float" }));
  expect(f.result.current.view?.settings).toMatchObject({
    encoding: "float",
    bitDepth: 32,
    dither: "none",
    noiseShaping: "none",
  });
  act(() => f.result.current.setSettings({ bitDepth: 64 }));
  act(() => f.result.current.setSettings({ encoding: "pcm" }));
  expect(f.result.current.view?.settings).toMatchObject({
    bitDepth: 24,
    dither: "none",
    noiseShaping: "none",
  });
});
it.each(["cancel", "chooser", "kernel", "write"] as const)(
  "keeps the dialog and settings for retry after %s",
  async (phase) => {
    const f = fixture();
    act(() => f.result.current.open(range));
    act(() => f.result.current.setSettings({ bitDepth: 16 }));
    if (phase === "cancel") vi.mocked(chooseSaveTarget).mockResolvedValueOnce(undefined);
    if (phase === "chooser")
      vi.mocked(chooseSaveTarget).mockRejectedValueOnce(new Error("chooser unavailable"));
    if (phase === "kernel") f.call.mockRejectedValueOnce(new Error("kernel export failed"));
    if (phase === "write") f.write.mockRejectedValueOnce(new Error("disk full"));
    await act(async () => f.result.current.submit());
    expect(f.result.current.view).toMatchObject({ phase: "idle", settings: { bitDepth: 16 } });
    expect(f.locked()).toBe(false);
    if (phase === "cancel") {
      expect(f.onError).not.toHaveBeenCalled();
      expect(f.call).not.toHaveBeenCalled();
    } else {
      expect(f.result.current.view?.error).toBeTruthy();
      expect(f.onError).toHaveBeenCalled();
    }
    const writing = deferred<void>();
    f.write.mockReturnValueOnce(writing.promise);
    let retry: Promise<void> | undefined;
    act(() => {
      retry = f.result.current.submit();
    });
    expect(f.result.current.view?.error).toBeUndefined();
    await act(async () => {
      writing.resolve();
      await retry;
    });
    expect(f.result.current.view).toBeUndefined();
  },
);
it("refuses a changed selection before exporting, so an open dialog cannot silently change its range", async () => {
  const f = fixture();
  act(() => f.result.current.open(range));
  act(() => f.result.current.setSettings({ scope: "selection" }));
  f.call.mockResolvedValueOnce({ ...range, end: 31, documentId: info.documentId });
  await act(async () => f.result.current.submit());
  expect(f.result.current.view?.error).toMatch(/selection changed/);
  expect(f.call).toHaveBeenCalledTimes(1);
  expect(f.write).not.toHaveBeenCalled();
});
it("prevents duplicate submit and ignores a chooser result after replacing the document", async () => {
  const f = fixture();
  const chooser = deferred<Awaited<ReturnType<typeof chooseSaveTarget>>>();
  vi.mocked(chooseSaveTarget).mockReturnValue(chooser.promise);
  act(() => f.result.current.open(range));
  let pending: Promise<void> | undefined;
  act(() => {
    pending = f.result.current.submit();
    f.result.current.submit();
    f.result.current.setSettings({ bitDepth: 8 });
  });
  expect(chooseSaveTarget).toHaveBeenCalledTimes(1);
  expect(f.result.current.view?.settings.bitDepth).toBe(24);
  f.rerender({ ...f.options, info: { ...info, documentId: "doc-2" } });
  expect(f.result.current.view).toBeUndefined();
  await act(async () => {
    chooser.resolve({ write: f.write });
    await pending;
  });
  expect(f.call).not.toHaveBeenCalled();
  expect(f.write).not.toHaveBeenCalled();
  expect(f.locked()).toBe(false);
});
it("cancels an idle dialog without choosing a file and rejects cursor selection exports", async () => {
  const f = fixture();
  act(() => f.result.current.open({ ...range, end: range.start }));
  act(() => f.result.current.setSettings({ scope: "selection" }));
  await act(async () => f.result.current.submit());
  expect(chooseSaveTarget).not.toHaveBeenCalled();
  await act(async () => f.result.current.cancel());
  expect(f.result.current.view).toBeUndefined();
});

it("exports lossy copies under the same write fence without changing the save point", async () => {
  vi.mocked(encoderSupport).mockResolvedValue({ opus: true, m4a: false });
  vi.mocked(exportLossy).mockResolvedValue({
    ...exported,
    name: "song.opus",
    mimeType: "audio/ogg",
  });
  const f = fixture();
  await act(async () => f.result.current.open(range));
  act(() => f.result.current.setSettings({ format: "opus" }));
  await act(async () => f.result.current.submit());
  expect(chooseSaveTarget).toHaveBeenCalledWith("song.opus", [
    { description: "OPUS audio", accept: { "audio/ogg": [".opus"] } },
  ]);
  expect(exportLossy).toHaveBeenCalledWith(
    f.options.client,
    info,
    range,
    "document",
    "opus",
    128,
    expect.any(AbortSignal),
  );
  expect(f.write).toHaveBeenCalledOnce();
  expect(f.call).not.toHaveBeenCalled();
  expect(f.locked()).toBe(false);
});

it("cancels native encoding before writing and releases the destination and fence", async () => {
  vi.mocked(encoderSupport).mockResolvedValue({ opus: true, m4a: false });
  vi.mocked(exportLossy).mockImplementation(
    async (...args) =>
      new Promise((_, reject) =>
        args[6].addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        ),
      ),
  );
  const f = fixture(),
    dispose = vi.fn();
  vi.mocked(chooseSaveTarget).mockResolvedValue({ write: f.write, dispose });
  await act(async () => f.result.current.open(range));
  act(() => f.result.current.setSettings({ format: "opus" }));
  act(() => {
    void f.result.current.submit();
  });
  await act(async () => Promise.resolve());
  expect(f.result.current.view?.canCancel).toBe(true);
  await act(async () => f.result.current.cancel());
  expect(f.write).not.toHaveBeenCalled();
  expect(dispose).toHaveBeenCalledOnce();
  expect(f.onError).not.toHaveBeenCalled();
  expect(f.result.current.view).toBeUndefined();
  expect(f.locked()).toBe(false);
});

it("ignores stale capability checks after range/bitrate changes and refuses unavailable export", async () => {
  const stale = deferred<{ opus: boolean; m4a: boolean }>();
  vi.mocked(encoderSupport).mockReturnValueOnce(stale.promise);
  const f = fixture();
  act(() => f.result.current.open(range));
  await act(async () =>
    f.result.current.setSettings({ format: "opus", scope: "selection", bitrate: 64 }),
  );
  await act(async () => stale.resolve({ opus: true, m4a: true }));
  expect(f.result.current.view?.support).toEqual({ opus: false, m4a: false });
  expect(encoderSupport).toHaveBeenLastCalledWith(48000, 1, 64);
  await act(async () => f.result.current.submit());
  expect(chooseSaveTarget).not.toHaveBeenCalled();
});
