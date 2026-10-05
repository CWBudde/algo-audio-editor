import type { DocumentMemoryResult } from "@aae/protocol";
import { type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { AudioEngine } from "@/audio/audio-engine";
import type { RingBufferStats } from "@/audio/ring-buffer";
import { ThirdPartyNotices } from "@/components/third-party-notices";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { KernelState } from "@/hooks/use-kernel";
import { formatBytes } from "@/lib/format-bytes";
import { desktopBridge } from "@/platform";

interface AboutStatusDialogProps {
  open: boolean;
  onClose(): void;
  kernel: KernelState;
  sampleRate?: number;
  stats?: RingBufferStats;
  engine?: Pick<AudioEngine, "stats">;
  memory?: DocumentMemoryResult;
  fallbackFocusRef?: RefObject<HTMLButtonElement | null>;
}

function Item({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-all text-right tabular-nums" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

/** Kept mounted while closed so diagnostics remain observable without crowding the editor. */
export function AboutStatusDialog({
  open,
  onClose,
  kernel,
  sampleRate,
  stats: suppliedStats,
  engine,
  memory,
  fallbackFocusRef,
}: AboutStatusDialogProps) {
  const [liveStats, setStats] = useState<RingBufferStats>();
  useEffect(() => {
    const read = () => setStats(engine?.stats());
    read();
    if (!engine) return;
    const timer = setInterval(read, 200);
    return () => clearInterval(timer);
  }, [engine]);
  const stats = engine ? liveStats : suppliedStats;
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | undefined>(undefined);
  const latestOpen = useRef(open);
  latestOpen.current = open;
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!open) {
      // Restore after React's commit-time focus restoration, once the launcher is enabled again.
      const target = opener.current?.isConnected ? opener.current : fallbackFocusRef?.current;
      if (opener.current) target?.focus({ preventScroll: true });
      opener.current = undefined;
      return;
    }
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement ? active : undefined;
    // Menu items can disappear when their popup closes. Restore the owning trigger instead.
    if (opener.current?.closest("[role='menu']")) {
      opener.current =
        document.querySelector<HTMLElement>("[aria-haspopup='menu'][aria-expanded='true']") ??
        opener.current;
    }
    if (!element.open) element.showModal();
    closeButton.current?.focus();
    return () => {
      if (element.open) element.close();
      if (!latestOpen.current) return;
      const target = opener.current?.isConnected ? opener.current : fallbackFocusRef?.current;
      target?.focus({ preventScroll: true });
      opener.current = undefined;
    };
  }, [open, fallbackFocusRef]);
  const hello = kernel.status === "ready" ? kernel.hello : undefined;
  const desktop = desktopBridge();
  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      aria-modal="true"
      data-testid="about-status-dialog"
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(30rem,calc(100vw-2rem))] overflow-auto rounded-lg border bg-popover p-5 text-popover-foreground shadow-xl backdrop:bg-black/50"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={() => {
        if (!dialog.current?.open) onClose();
      }}
    >
      <h2 id={`${id}-title`} className="text-lg font-medium">
        About / Status
      </h2>
      <p id={`${id}-description`} className="mt-1 text-sm text-muted-foreground">
        algo-audio-editor · Live diagnostics. Playback continues while this dialog is open.
      </p>
      <Badge
        variant={kernel.status === "error" ? "destructive" : "secondary"}
        data-testid="kernel-status"
        className="mt-4"
        title={kernel.status === "error" ? kernel.error : kernel.status}
      >
        kernel {kernel.status}
      </Badge>
      {kernel.status === "error" && <p className="mt-2 text-sm text-destructive">{kernel.error}</p>}
      <dl className="mt-4 space-y-2 text-sm">
        <Item
          label="Kernel"
          value={hello ? `${hello.kernelVersion} (${hello.goVersion})` : "–"}
          testId="kernel-version"
        />
        <Item label="Protocol" value={hello ? `ABI v${hello.protocolVersion}` : "–"} />
        <Item
          label="Build"
          value={`${import.meta.env.VITE_BUILD_CHANNEL} build`}
          testId="build-channel"
        />
        <Item label="Commit" value={import.meta.env.VITE_BUILD_COMMIT} testId="build-commit" />
        <Item label="Built (UTC)" value={hello?.buildTime || "–"} testId="build-time" />
        <Item label="Device rate" value={`${sampleRate ?? hello?.sampleRate ?? "–"} Hz`} />
        <Item
          label="Memory"
          value={memory ? formatBytes(memory.sampleBytes + memory.peakBytes) : "–"}
          testId="document-memory"
        />
        <Item
          label="Isolated"
          value={globalThis.crossOriginIsolated ? "yes" : "no"}
          testId="cross-origin-isolated"
        />
        <Item label="Played" value={String(stats?.consumedFrames ?? 0)} testId="frames-played" />
        <Item label="Buffered" value={String(stats?.bufferedFrames ?? 0)} />
        <Item label="Underruns" value={String(stats?.underrunFrames ?? 0)} testId="underruns" />
        <Item
          label="Platform"
          value={desktop ? `Electron ${desktop.versions.electron}` : "Browser"}
          testId="platform"
        />
      </dl>
      {open && <ThirdPartyNotices />}
      <div className="mt-5 flex justify-end">
        <Button ref={closeButton} onClick={onClose} aria-label="Close information">
          Close
        </Button>
      </div>
    </dialog>
  );
}
