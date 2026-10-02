import type { ExportResult } from "@aae/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chooseAudioFile, chooseSaveTarget } from "./file-access";

const exported: ExportResult = {
  name: "test.wav",
  mimeType: "audio/wav",
  dataBytes: 4,
  data: new ArrayBuffer(4),
};

afterEach(() => {
  delete window.showOpenFilePicker;
  delete window.showSaveFilePicker;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("audio file dialogs", () => {
  it("uses the file input only when a native picker is absent or unsupported", async () => {
    const fallback = vi.fn();
    await chooseAudioFile(fallback);
    expect(fallback).toHaveBeenCalledTimes(1);
    window.showOpenFilePicker = vi
      .fn()
      .mockRejectedValue(new DOMException("unsupported", "NotSupportedError"));
    await chooseAudioFile(fallback);
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it("returns the selected file without opening a second picker", async () => {
    const file = new File(["wave"], "selected.wav");
    window.showOpenFilePicker = vi.fn().mockResolvedValue([{ getFile: async () => file }]);
    const fallback = vi.fn();
    expect(await chooseAudioFile(fallback)).toBe(file);
    expect(fallback).not.toHaveBeenCalled();
    expect(window.showOpenFilePicker).toHaveBeenCalledWith(
      expect.objectContaining({ multiple: false }),
    );
  });

  it("treats open and save cancellation as cancellation without fallback or file writes", async () => {
    const cancelled = new DOMException("cancelled", "AbortError");
    const fallback = vi.fn();
    window.showOpenFilePicker = vi.fn().mockRejectedValue(cancelled);
    window.showSaveFilePicker = vi.fn().mockRejectedValue(cancelled);
    expect(await chooseAudioFile(fallback)).toBeUndefined();
    expect(await chooseSaveTarget("test.wav")).toBeUndefined();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("reports picker permission errors instead of starting a second dialog", async () => {
    const failure = new DOMException("denied", "SecurityError");
    const fallback = vi.fn();
    window.showOpenFilePicker = vi.fn().mockRejectedValue(failure);
    window.showSaveFilePicker = vi.fn().mockRejectedValue(failure);
    await expect(chooseAudioFile(fallback)).rejects.toBe(failure);
    await expect(chooseSaveTarget("test.wav")).rejects.toBe(failure);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("creates a writable only after export succeeds, writes the binary blob and closes it", async () => {
    const writable = {
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const createWritable = vi.fn().mockResolvedValue(writable);
    window.showSaveFilePicker = vi.fn().mockResolvedValue({ createWritable });
    const target = await chooseSaveTarget("test.wav");
    expect(createWritable).not.toHaveBeenCalled();
    await target?.write(exported);
    expect(writable.write).toHaveBeenCalledWith(expect.any(Blob));
    expect(writable.write.mock.calls[0][0].size).toBe(4);
    expect(writable.close).toHaveBeenCalledTimes(1);
  });

  it("aborts an unsuccessful file write", async () => {
    const error = new Error("disk full");
    const writable = {
      write: vi.fn().mockRejectedValue(error),
      close: vi.fn(),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    window.showSaveFilePicker = vi.fn().mockResolvedValue({ createWritable: async () => writable });
    const target = await chooseSaveTarget("test.wav");
    await expect(target?.write(exported)).rejects.toBe(error);
    expect(writable.close).not.toHaveBeenCalled();
    expect(writable.abort).toHaveBeenCalledTimes(1);
  });

  it.each(["unavailable", "unsupported"])(
    "downloads binary output when save pickers are %s, then releases its object URL",
    async (availability) => {
      if (availability === "unsupported") {
        window.showSaveFilePicker = vi
          .fn()
          .mockRejectedValue(new DOMException("unsupported", "NotSupportedError"));
      }
      vi.useFakeTimers();
      const createObjectURL = vi.fn((_blob: Blob) => "blob:export");
      const revokeObjectURL = vi.fn();
      vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
      const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        expect(this.download).toBe("test.wav");
        expect(this.href).toBe("blob:export");
        expect(this.isConnected).toBe(true);
      });
      const target = await chooseSaveTarget("test.wav");
      await target?.write(exported);
      expect(click).toHaveBeenCalledTimes(1);
      expect(createObjectURL.mock.calls[0][0]).toBeInstanceOf(Blob);
      expect(document.querySelector("a")).toBeNull();
      expect(revokeObjectURL).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1_000);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:export");
    },
  );
});
