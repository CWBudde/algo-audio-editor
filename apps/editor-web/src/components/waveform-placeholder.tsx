import type { DocumentInfoResult } from "@aae/protocol";
import { FileAudio } from "lucide-react";
import { Button } from "@/components/ui/button";

export function WaveformPlaceholder({
  info,
  disabled,
  onOpen,
  onDemo,
}: {
  info?: DocumentInfoResult;
  disabled?: boolean;
  onOpen?(): void;
  onDemo?(): void;
}) {
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
          Click the waveform to seek, or drag a range to select playback.
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
          Open an audio file or drop it here to view its waveform and play it.
        </p>
        <p className="text-sm text-muted-foreground">
          Edit, process and analyze audio locally in your browser. Your audio stays on this device;
          files are never uploaded.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button disabled={disabled} onClick={onOpen}>
            Open audio file
          </Button>
          <Button variant="outline" disabled={disabled} onClick={onDemo}>
            Open demo
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">Demo: four seconds of quiet stereo tones.</p>
        <div className="flex gap-4 text-sm">
          <a
            className="underline"
            href="https://github.com/cwbudde/algo-audio-editor"
            target="_blank"
            rel="noreferrer"
          >
            Source code
          </a>
          <a
            className="underline"
            href="https://github.com/cwbudde/algo-audio-editor/blob/main/PLAN.md"
            target="_blank"
            rel="noreferrer"
          >
            Roadmap
          </a>
        </div>
      </div>
    </div>
  );
}
