import type { DocumentMemoryResult, HelloResult } from "@aae/protocol";
import type { RingBufferStats } from "@/audio/ring-buffer";
import { Badge } from "@/components/ui/badge";
import type { KernelState } from "@/hooks/use-kernel";
import { formatBytes } from "@/lib/format-bytes";
import { desktopBridge } from "@/platform";

interface StatusBarProps {
  kernel: KernelState;
  sampleRate?: number;
  stats?: RingBufferStats;
  memory?: DocumentMemoryResult;
}

function Item({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums" data-testid={testId}>
        {value}
      </span>
    </span>
  );
}

function kernelLabel(state: KernelState): string {
  return state.status === "error" ? `error: ${state.error}` : state.status;
}

function versionOf(hello: HelloResult | undefined): string {
  return hello ? `${hello.kernelVersion} (${hello.goVersion})` : "–";
}

export function StatusBar({ kernel, sampleRate, stats, memory }: StatusBarProps) {
  const hello = kernel.status === "ready" ? kernel.hello : undefined;
  const desktop = desktopBridge();

  return (
    <footer className="flex h-7 items-center gap-4 border-t px-3 text-xs">
      <Badge
        variant={kernel.status === "error" ? "destructive" : "secondary"}
        data-testid="kernel-status"
        title={kernelLabel(kernel)}
      >
        kernel {kernel.status}
      </Badge>
      <Item label="Kernel" value={versionOf(hello)} testId="kernel-version" />
      <Item label="Rate" value={`${sampleRate ?? hello?.sampleRate ?? "–"} Hz`} />
      <Item
        label="Memory"
        value={memory ? formatBytes(memory.sampleBytes) : "–"}
        testId="document-memory"
      />
      <Item
        label="Isolated"
        value={globalThis.crossOriginIsolated ? "yes" : "no"}
        testId="cross-origin-isolated"
      />
      <span className="flex-1" />
      <Item label="Played" value={String(stats?.consumedFrames ?? 0)} testId="frames-played" />
      <Item label="Buffered" value={String(stats?.bufferedFrames ?? 0)} />
      <Item label="Underruns" value={String(stats?.underrunFrames ?? 0)} testId="underruns" />
      <Item
        label="Platform"
        value={desktop ? `Electron ${desktop.versions.electron}` : "Browser"}
        testId="platform"
      />
    </footer>
  );
}
