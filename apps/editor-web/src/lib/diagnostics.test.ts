import type { HelloResult } from "@aae/protocol";
import { afterEach, expect, it, vi } from "vitest";
import type { KernelState } from "@/hooks/use-kernel";
import { desktopFixture } from "@/lib/desktop-test-fixture";
import { copyDiagnostics, diagnosticItems, diagnosticsText } from "./diagnostics";

const ready: KernelState = {
  status: "ready",
  client: {} as never,
  hello: {
    kernelVersion: "test",
    goVersion: "go1.test",
    protocolVersion: 10,
    sampleRate: 48000,
    buildTime: "2026-10-09T00:00:00Z",
  } as HelloResult,
};

afterEach(() => {
  delete window.aaeDesktop;
  vi.unstubAllGlobals();
});

it("lists the About dialog's facts from the kernel, engine and document memory", () => {
  const items = diagnosticItems({
    kernel: ready,
    sampleRate: 44100,
    stats: {
      consumedFrames: 480,
      bufferedFrames: 96,
      underrunFrames: 2,
      documentFrame: 0,
      ended: false,
    },
    memory: { sampleBytes: 1024, peakBytes: 1024, uniqueBlocks: 1, blockReferences: 1 },
  });
  const values = Object.fromEntries(items.map((item) => [item.label, item.value]));
  expect(values).toMatchObject({
    Kernel: "test (go1.test)",
    Protocol: "ABI v10",
    "Built (UTC)": "2026-10-09T00:00:00Z",
    "Device rate": "44100 Hz",
    Memory: "2 KiB",
    Played: "480",
    Buffered: "96",
    Underruns: "2",
    Platform: "Browser",
  });
  expect(items.map((item) => item.label)).toEqual([
    "Kernel",
    "Protocol",
    "Build",
    "Commit",
    "Built (UTC)",
    "Device rate",
    "Memory",
    "Isolated",
    "Played",
    "Buffered",
    "Underruns",
    "Platform",
  ]);
});

it("falls back to placeholders before the kernel is ready", () => {
  const values = Object.fromEntries(
    diagnosticItems({ kernel: { status: "loading" } }).map((item) => [item.label, item.value]),
  );
  expect(values).toMatchObject({
    Kernel: "–",
    Protocol: "–",
    "Device rate": "– Hz",
    Memory: "–",
    Played: "0",
  });
});

it("formats one plain-text line per fact, headed by the kernel status", () => {
  const text = diagnosticsText({ kernel: ready, sampleRate: 48000 });
  const lines = text.split("\n");
  expect(lines[0]).toBe("algo-audio-editor diagnostics");
  expect(lines[1]).toBe("Kernel status: ready");
  expect(lines).toContain("Kernel: test (go1.test)");
  expect(lines).toContain("Device rate: 48000 Hz");
  expect(text.endsWith("\n")).toBe(true);
});

it("includes the kernel error and the Electron version on desktop", () => {
  window.aaeDesktop = desktopFixture();
  const text = diagnosticsText({ kernel: { status: "error", error: "boot failed" } });
  expect(text).toContain("Kernel status: error\nKernel error: boot failed\n");
  expect(text).toContain("Platform: Electron test\n");
});

it("copies the diagnostics text with the browser clipboard", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  await copyDiagnostics({ kernel: ready });
  expect(writeText).toHaveBeenCalledExactlyOnceWith(diagnosticsText({ kernel: ready }));
});

it("copies through the desktop bridge in Electron", async () => {
  const writeText = vi.fn();
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  const bridge = desktopFixture();
  window.aaeDesktop = bridge;
  await copyDiagnostics({ kernel: ready });
  expect(bridge.copyText).toHaveBeenCalledExactlyOnceWith(diagnosticsText({ kernel: ready }));
  expect(writeText).not.toHaveBeenCalled();
});

it("rejects when the clipboard refuses the write", async () => {
  const failure = new Error("Write permission denied.");
  vi.stubGlobal("navigator", {
    ...navigator,
    clipboard: { writeText: vi.fn().mockRejectedValue(failure) },
  });
  await expect(copyDiagnostics({ kernel: ready })).rejects.toBe(failure);
});
