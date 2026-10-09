import { useId, useLayoutEffect, useRef } from "react";
import type { useBatch } from "@/hooks/use-batch";
import { AUDIO_ACCEPT } from "@/lib/audio-codecs";
import { batchFolderAvailable } from "@/lib/batch-output";
import { type BatchFormat, batchDepths, batchOutputNames } from "@/lib/batch-settings";
import { describeOperation } from "@/lib/operation-chain";
import { desktopBridge } from "@/platform";

export function BatchDialog({ batch }: { batch: ReturnType<typeof useBatch> }) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    if (!batch.open) return;
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.showModal();
    return () => {
      dialog.current?.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [batch.open]);
  let names: string[] = [];
  let namingError: string | undefined;
  if (batch.files.length) {
    try {
      names = batchOutputNames(batch.files, batch.settings);
    } catch (error) {
      namingError = error instanceof Error ? error.message : String(error);
    }
  }
  const succeeded = batch.progress.filter((row) => row.state === "Done").length;
  const failed = batch.progress.filter((row) => row.state === "Failed").length;
  const cancelled = batch.progress.filter((row) => row.state === "Cancelled").length;
  const button =
    "studio-button border px-3 py-2 text-xs disabled:opacity-50 focus-within:ring-1 focus-within:ring-ring";
  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${id}-title`}
      aria-modal="true"
      className="studio-dialog m-auto max-h-[calc(100dvh-2rem)] w-[min(48rem,calc(100vw-2rem))] overflow-y-auto border p-5 text-popover-foreground backdrop:bg-background/75 backdrop:backdrop-blur-[2px]"
      onCancel={(event) => {
        event.preventDefault();
        if (batch.running) batch.cancel();
        else batch.close();
      }}
    >
      <h2 id={`${id}-title`} className="studio-dialog-heading text-lg font-semibold tracking-tight">
        Batch processing
      </h2>
      <p className="studio-dialog-help my-2 max-w-[72ch] text-xs leading-relaxed text-muted-foreground">
        Apply a chain to each file, or leave it empty to convert formats. Whole-document steps adapt
        to each file; partial ranges retain sample coordinates. Each file runs separately from the
        open editor document.
      </p>
      {(batch.error || namingError) && (
        <p role="alert" className="my-2 break-words text-destructive">
          {batch.error ?? namingError}
        </p>
      )}
      <fieldset
        disabled={batch.working}
        className="studio-section my-3 space-y-3 border p-3 text-xs"
      >
        <div className="flex flex-wrap gap-2">
          <label className={`${button} ${batch.working ? "opacity-50" : "cursor-pointer"}`}>
            Choose audio files
            <input
              aria-label="Batch audio files"
              className="sr-only"
              type="file"
              multiple
              accept={AUDIO_ACCEPT}
              onChange={(event) => {
                batch.selectFiles(Array.from(event.currentTarget.files ?? []));
                event.currentTarget.value = "";
              }}
            />
          </label>
          <label className={`${button} ${batch.working ? "opacity-50" : "cursor-pointer"}`}>
            Import chain
            <input
              aria-label="Import batch chain"
              className="sr-only"
              type="file"
              accept=".json,application/json"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) void batch.load(file);
              }}
            />
          </label>
          <button className={button} type="button" onClick={batch.chooseMacro}>
            Use current macro
          </button>
          <button className={button} type="button" onClick={batch.clearChain}>
            Clear chain
          </button>
        </div>
        <p>{batch.chain.operations.length} operations in chain</p>
        {batch.chain.operations.length > 0 && (
          <ol className="max-h-32 list-decimal overflow-y-auto border-l border-border/60 pl-6 text-xs leading-relaxed marker:text-muted-foreground">
            {batch.chain.operations.map((operation, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: The ordered chain has no editable row state.
              <li key={index}>
                {describeOperation(operation)}
                {operation.range === "document" ? " · Whole document" : " · Sample coordinates"}
              </li>
            ))}
          </ol>
        )}
        <div className="grid grid-cols-2 gap-3 border-t border-border/60 pt-3 sm:grid-cols-4">
          <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
            Output format
            <select
              aria-label="Batch output format"
              className="studio-field min-w-0 w-full border px-2 py-1.5 text-foreground"
              value={batch.settings.format}
              onChange={(event) =>
                batch.changeSettings({ format: event.currentTarget.value as BatchFormat })
              }
            >
              <option value="wav">WAV</option>
              <option value="flac">FLAC</option>
              <option value="aiff">AIFF</option>
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
            Encoding
            <select
              aria-label="Batch encoding"
              className="studio-field min-w-0 w-full border px-2 py-1.5 text-foreground"
              value={batch.settings.encoding}
              disabled={batch.settings.format !== "wav"}
              onChange={(event) =>
                batch.changeSettings({ encoding: event.currentTarget.value as "pcm" | "float" })
              }
            >
              <option value="pcm">PCM</option>
              <option value="float">Float</option>
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
            Bit depth
            <select
              aria-label="Batch bit depth"
              className="studio-field min-w-0 w-full border px-2 py-1.5 text-foreground"
              value={batch.settings.bitDepth}
              onChange={(event) =>
                batch.changeSettings({ bitDepth: Number(event.currentTarget.value) })
              }
            >
              {batchDepths(batch.settings).map((depth) => (
                <option key={depth} value={depth}>
                  {depth}-bit
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
            Output suffix
            <input
              aria-label="Output suffix"
              className="studio-field min-w-0 w-full border px-2 py-1.5 text-foreground"
              value={batch.settings.suffix}
              onChange={(event) => batch.changeSettings({ suffix: event.currentTarget.value })}
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            className={button}
            type="button"
            disabled={!batchFolderAvailable()}
            onClick={() => void batch.chooseFolder()}
          >
            Choose output folder
          </button>
          {!desktopBridge() && (
            <button className={button} type="button" onClick={() => void batch.chooseDownloads()}>
              Use downloads
            </button>
          )}
          <span className="min-w-0 break-words text-xs text-muted-foreground">
            Output: {batch.destination?.label ?? "Choose a folder"}
          </span>
        </div>
        <p className="text-muted-foreground">
          {batch.destination?.mode === "downloads"
            ? "One download is requested per successful file. Your browser may ask to allow multiple downloads; choose a folder to save directly where supported."
            : "Existing output files are preserved. A failed file is skipped and the batch continues. Cancelling keeps files already saved, including a save in progress."}
        </p>
      </fieldset>
      <p
        role="status"
        aria-label="Batch progress"
        className="studio-readout my-3 text-xs tabular-nums"
      >
        {succeeded + failed + cancelled} of {batch.files.length} files completed · {succeeded}{" "}
        succeeded · {failed} failed · {cancelled} cancelled
        {batch.running ? " · Running" : batch.finished ? " · Finished" : ""}
      </p>
      <ol className="my-3 max-h-64 space-y-2 overflow-y-auto text-xs" aria-label="Batch files">
        {batch.files.map((file, index) => {
          const row = batch.progress[index];
          return (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: The file list is replaced as a whole while idle.
              key={index}
              data-testid={`batch-file-${index}`}
              className="studio-section border p-3"
            >
              <p className="break-words font-medium">
                {file.name} → {names[index] ?? "Invalid output name"}
              </p>
              <p
                className={
                  row?.state === "Failed" ? "break-words text-destructive" : "text-muted-foreground"
                }
              >
                {row?.state ?? "Waiting"}
                {row?.total !== undefined ? ` · ${row.completed} of ${row.total} operations` : ""}
                {row?.phase ? ` · ${row.phase}` : ""}
                {row?.error ? ` · ${row.error}` : ""}
              </p>
            </li>
          );
        })}
      </ol>
      <div className="studio-dialog-actions flex flex-wrap gap-2 border-t pt-3 text-sm">
        <button
          className="studio-button studio-button-primary border px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
          type="button"
          disabled={
            batch.working || !batch.files.length || !batch.destination || Boolean(namingError)
          }
          onClick={() => void batch.start()}
        >
          Start batch
        </button>
        {batch.running && (
          <button className={button} type="button" onClick={batch.cancel}>
            Cancel batch
          </button>
        )}
        <button
          className={`${button} ml-auto`}
          type="button"
          disabled={batch.working}
          onClick={batch.close}
        >
          Close
        </button>
      </div>
    </dialog>
  );
}
