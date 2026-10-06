import type { DocumentInfoResult } from "@aae/protocol";
import { Button } from "@/components/ui/button";
import { FileAudio } from "@/lib/icons";

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
        className="editor-empty-state flex min-h-[20rem] flex-1 flex-col items-center justify-center gap-3 rounded-lg border p-6"
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
    <div className="editor-empty-state flex min-h-[20rem] flex-1 items-center justify-center rounded-lg border p-6">
      <div className="flex max-w-md flex-col items-center gap-4 p-4 text-center sm:p-10">
        <div className="editor-empty-icon flex size-16 items-center justify-center rounded-2xl border">
          <FileAudio className="size-7 text-primary" aria-hidden="true" />
        </div>
        <div>
          <p className="mb-2 text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Your audio workspace
          </p>
          <h1 className="text-xl font-semibold tracking-tight">No document open</h1>
        </div>
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
        <p className="text-[11px] text-muted-foreground">
          Demo: four seconds of quiet stereo tones.
        </p>
        <div className="flex gap-4 text-xs text-muted-foreground">
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
