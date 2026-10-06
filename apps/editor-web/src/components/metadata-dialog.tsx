import { useId, useLayoutEffect, useRef, useState } from "react";
import type { MetadataView } from "@/hooks/use-metadata";

export const METADATA_FIELDS = [
  ["title", "Title"],
  ["artist", "Artist"],
  ["album", "Album"],
  ["track", "Track"],
  ["date", "Date"],
  ["genre", "Genre"],
  ["comment", "Comment"],
  ["copyright", "Copyright"],
  ["engineer", "Engineer"],
  ["technician", "Technician"],
  ["keywords", "Keywords"],
  ["medium", "Medium"],
  ["subject", "Subject"],
  ["software", "Software"],
  ["source", "Source"],
  ["location", "Archival location"],
] as const;

export function MetadataDialog({
  view,
  onCancel,
  onCommit,
}: {
  view?: MetadataView;
  onCancel(): void;
  onCommit(tags: Record<string, string>): void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [tags, setTags] = useState<Record<string, string>>({});
  const open = Boolean(view);
  useLayoutEffect(() => {
    if (!open) return;
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.showModal();
    return () => {
      dialog.current?.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open]);
  const metadata = view?.metadata;
  useLayoutEffect(() => {
    setTags(metadata?.tags ?? {});
    if (metadata) dialog.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [metadata]);
  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${id}-title`}
      aria-modal="true"
      className="studio-dialog m-auto max-h-[calc(100dvh-2rem)] w-[min(42rem,calc(100vw-2rem))] overflow-y-auto border p-5 text-popover-foreground backdrop:bg-background/75 backdrop:backdrop-blur-[2px]"
      onCancel={(event) => {
        event.preventDefault();
        if (!view?.committing) onCancel();
      }}
    >
      <h2 id={`${id}-title`} className="studio-dialog-heading text-lg font-semibold tracking-tight">
        File metadata
      </h2>
      {view && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (metadata && !view.working) onCommit(tags);
          }}
        >
          <p className="studio-section my-3 break-words border px-3 py-2 text-xs text-muted-foreground">
            {view.name}
          </p>
          <p className="studio-dialog-help my-2 max-w-[72ch] text-xs leading-relaxed text-muted-foreground">
            Tags are saved in WAV files. Use WAV export to keep these tags when converting from
            another format. Changes are undoable.
          </p>
          {view.error && (
            <p role="alert" className="text-sm text-destructive">
              {view.error}
            </p>
          )}
          {view.working && (
            <p role="status" className="my-2 text-xs text-muted-foreground">
              {view.committing ? "Applying metadata…" : "Reading metadata…"}
            </p>
          )}
          {metadata && (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {METADATA_FIELDS.map(([key, label]) => (
                  <label
                    key={key}
                    className="flex min-w-0 flex-col gap-1 text-xs font-medium text-muted-foreground"
                  >
                    {label}
                    <input
                      className="studio-field min-w-0 border px-2 py-1.5 text-sm font-normal text-foreground"
                      value={tags[key] ?? ""}
                      disabled={view.working}
                      maxLength={65536}
                      onChange={(event) =>
                        setTags((previous) => ({ ...previous, [key]: event.target.value }))
                      }
                    />
                  </label>
                ))}
              </div>
              {metadata.preservedBytes > 0 && (
                <p className="mt-3 break-words text-xs text-muted-foreground">
                  Retained WAV chunks: {metadata.chunks.join(", ")} (
                  {metadata.preservedBytes.toLocaleString()} bytes). Broadcast and other opaque
                  chunks are retained on whole-document WAV export; selection exports include tags
                  and surviving annotations.
                </p>
              )}
            </>
          )}
          <div className="studio-dialog-actions mt-4 flex justify-end gap-2 border-t pt-3">
            <button
              type="button"
              className="studio-button border px-3 py-2 text-sm disabled:opacity-50"
              disabled={view.committing}
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="studio-button studio-button-primary border px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
              disabled={!metadata || view.working}
            >
              Apply metadata
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
