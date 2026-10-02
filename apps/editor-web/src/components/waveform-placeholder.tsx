import type { DocumentInfoResult } from "@aae/protocol";
import { FileAudio } from "lucide-react";

export function WaveformPlaceholder({ info }: { info?: DocumentInfoResult }) {
  if (info) {
    return (
      <section
        className="flex h-full flex-col items-center justify-center gap-3 p-6"
        data-testid="document-info"
      >
        <FileAudio className="size-10 text-muted-foreground" />
        <h1 className="text-lg font-semibold" data-testid="document-name">
          {info.name}
        </h1>
        <p className="text-sm tabular-nums" data-testid="document-details">
          {info.sampleRate} Hz · {info.channels} {info.channels === 1 ? "channel" : "channels"} ·{" "}
          {info.frames} frames · {(info.frames / info.sampleRate).toFixed(3)} s · {info.bitDepth}
          -bit {info.float ? "float" : "PCM"}
        </p>
        <p className="text-sm text-muted-foreground">
          Test tone playback is independent of this document.
        </p>
      </section>
    );
  }
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex max-w-md flex-col items-center gap-3 rounded-xl border border-dashed p-10 text-center">
        <FileAudio className="size-10 text-muted-foreground" />
        <p className="font-medium">No document open</p>
        <p className="text-sm text-muted-foreground">
          Open a WAV file or drop it here to begin. The transport plays a test tone.
        </p>
      </div>
    </div>
  );
}
