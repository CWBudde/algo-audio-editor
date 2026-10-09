import type { DocumentMemoryResult } from "@aae/protocol";
import type { RingBufferStats } from "@/audio/ring-buffer";
import type { KernelState } from "@/hooks/use-kernel";
import { formatBytes } from "@/lib/format-bytes";
import { desktopBridge } from "@/platform";

export interface DiagnosticsSource {
  kernel: KernelState;
  sampleRate?: number;
  stats?: RingBufferStats;
  memory?: DocumentMemoryResult;
}

export interface DiagnosticItem {
  label: string;
  value: string;
  testId?: string;
}

/** The About dialog and Help → Copy diagnostics show the same facts in the same order. */
export function diagnosticItems({
  kernel,
  sampleRate,
  stats,
  memory,
}: DiagnosticsSource): DiagnosticItem[] {
  const hello = kernel.status === "ready" ? kernel.hello : undefined;
  const desktop = desktopBridge();
  return [
    {
      label: "Kernel",
      value: hello ? `${hello.kernelVersion} (${hello.goVersion})` : "–",
      testId: "kernel-version",
    },
    { label: "Protocol", value: hello ? `ABI v${hello.protocolVersion}` : "–" },
    {
      label: "Build",
      value: `${import.meta.env.VITE_BUILD_CHANNEL} build`,
      testId: "build-channel",
    },
    { label: "Commit", value: import.meta.env.VITE_BUILD_COMMIT, testId: "build-commit" },
    { label: "Built (UTC)", value: hello?.buildTime || "–", testId: "build-time" },
    { label: "Device rate", value: `${sampleRate ?? hello?.sampleRate ?? "–"} Hz` },
    {
      label: "Memory",
      value: memory ? formatBytes(memory.sampleBytes + memory.peakBytes) : "–",
      testId: "document-memory",
    },
    {
      label: "Isolated",
      value: globalThis.crossOriginIsolated ? "yes" : "no",
      testId: "cross-origin-isolated",
    },
    { label: "Played", value: String(stats?.consumedFrames ?? 0), testId: "frames-played" },
    { label: "Buffered", value: String(stats?.bufferedFrames ?? 0) },
    { label: "Underruns", value: String(stats?.underrunFrames ?? 0), testId: "underruns" },
    {
      label: "Platform",
      value: desktop ? `Electron ${desktop.versions.electron}` : "Browser",
      testId: "platform",
    },
  ];
}

/** Plain text for bug reports; one `Label: value` line per fact. */
export function diagnosticsText(source: DiagnosticsSource): string {
  const { kernel } = source;
  const lines = [
    "algo-audio-editor diagnostics",
    `Kernel status: ${kernel.status}`,
    ...(kernel.status === "error" ? [`Kernel error: ${kernel.error}`] : []),
    ...diagnosticItems(source).map((item) => `${item.label}: ${item.value}`),
  ];
  return `${lines.join("\n")}\n`;
}

/** Electron writes through the main process; browsers use the async clipboard API. */
export async function copyDiagnostics(source: DiagnosticsSource): Promise<void> {
  const text = diagnosticsText(source);
  const bridge = desktopBridge();
  if (bridge?.copyText) await bridge.copyText(text);
  else await navigator.clipboard.writeText(text);
}
