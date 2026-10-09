import type { DocumentMemoryResult } from "@aae/protocol";
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import type { AudioEngine } from "@/audio/audio-engine";
import type { RingBufferStats } from "@/audio/ring-buffer";
import { ThirdPartyNotices } from "@/components/third-party-notices";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { KernelState } from "@/hooks/use-kernel";
import { useRestoringModal } from "@/hooks/use-restoring-modal";
import { diagnosticItems } from "@/lib/diagnostics";

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
      <dd className="min-w-0 break-all text-right tabular-nums" data-testid={testId}>
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
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRestoringModal(open, closeButton, fallbackFocusRef);
  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      aria-modal="true"
      data-testid="about-status-dialog"
      className="studio-dialog m-auto max-h-[calc(100dvh-2rem)] w-[min(30rem,calc(100vw-2rem))] overflow-y-auto border p-5 text-popover-foreground backdrop:bg-background/75 backdrop:backdrop-blur-[2px]"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={() => {
        if (!dialog.current?.open) onClose();
      }}
    >
      <h2 id={`${id}-title`} className="studio-dialog-heading text-lg font-semibold tracking-tight">
        About / Status
      </h2>
      <p
        id={`${id}-description`}
        className="studio-dialog-help mt-1 text-xs leading-relaxed text-muted-foreground"
      >
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
      <dl className="studio-section mt-3 divide-y divide-border/50 border px-3 text-xs [&>div]:py-2">
        {diagnosticItems({ kernel, sampleRate, stats, memory }).map((item) => (
          <Item key={item.label} {...item} />
        ))}
      </dl>
      {open && <ThirdPartyNotices />}
      <div className="studio-dialog-actions mt-4 flex justify-end border-t pt-3">
        <Button ref={closeButton} onClick={onClose} aria-label="Close information">
          Close
        </Button>
      </div>
    </dialog>
  );
}
