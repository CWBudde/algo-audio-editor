import { FileAudio } from "lucide-react";

/** Stands in for the waveform view until Phase 1 brings documents. */
export function WaveformPlaceholder() {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex max-w-md flex-col items-center gap-3 rounded-xl border border-dashed p-10 text-center">
        <FileAudio className="size-10 text-muted-foreground" />
        <p className="font-medium">No document open</p>
        <p className="text-sm text-muted-foreground">
          Opening and editing audio files arrives in Phase 1. For now, play the kernel's test tone
          to check the Go → Worker → AudioWorklet pipeline.
        </p>
      </div>
    </div>
  );
}
