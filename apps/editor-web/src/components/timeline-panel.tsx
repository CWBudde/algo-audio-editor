import type {
  DocumentInfoResult,
  MarkerUpdateParams,
  RegionUpdateParams,
  SelectionRange,
  TimelineMarker,
  TimelineRegion,
  TimelineResult,
} from "@aae/protocol";
import { useEffect, useId, useState } from "react";
import { ControlDisclosure } from "@/components/control-disclosure";
import { Button } from "@/components/ui/button";
import { ListMusic } from "@/lib/icons";
import { formatSelectionTime, parseSelectionTime } from "@/lib/selection";
import type { TimeFormat } from "@/lib/waveform-geometry";

interface TimelinePanelProps {
  info: DocumentInfoResult;
  timeline: TimelineResult;
  selection: SelectionRange;
  timeFormat: TimeFormat;
  busy?: boolean;
  sessionKey?: object;
  onUpdateMarker(changes: Omit<MarkerUpdateParams, "documentId" | "selection">): void;
  onUpdateRegion(changes: Omit<RegionUpdateParams, "documentId" | "selection">): void;
  onRemoveMarker(id: number): void;
  onRemoveRegion(id: number): void;
  onJump(selection: SelectionRange): void;
  onExport?(format: "csv" | "labels"): void;
}

interface Draft {
  sessionKey: object;
  documentId: string;
  kind: "marker" | "region";
  id: number;
  name: string;
  color: string;
  start: string;
  end: string;
  format: TimeFormat;
  error?: string;
}

/** Metadata controls only. File serialization and timeline authority stay in Go. */
export function TimelinePanel({
  info,
  timeline,
  selection,
  timeFormat,
  busy = false,
  sessionKey = info,
  onUpdateMarker,
  onUpdateRegion,
  onRemoveMarker,
  onRemoveRegion,
  onJump,
  onExport,
}: TimelinePanelProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>();
  const id = useId();
  useEffect(
    () =>
      setDraft((current) =>
        current?.documentId === info.documentId && current.sessionKey === sessionKey
          ? current
          : undefined,
      ),
    [info.documentId, sessionKey],
  );
  const currentDraft =
    draft?.documentId === info.documentId && draft.sessionKey === sessionKey ? draft : undefined;
  const edit = (kind: "marker" | "region", anchor: TimelineMarker | TimelineRegion) => {
    if (busy) return;
    const start = "frame" in anchor ? anchor.frame : anchor.start;
    const end = "frame" in anchor ? anchor.frame : anchor.end;
    setDraft({
      documentId: info.documentId,
      sessionKey,
      kind,
      id: anchor.id,
      name: anchor.name,
      color: anchor.color,
      start: formatSelectionTime(start, info.sampleRate, timeFormat),
      end: formatSelectionTime(end, info.sampleRate, timeFormat),
      format: timeFormat,
    });
  };
  const save = () => {
    if (busy || !currentDraft) return;
    const name = currentDraft.name.trim();
    if (!name || name.includes("\0") || new TextEncoder().encode(name).byteLength > 256) {
      setDraft({
        ...currentDraft,
        error: "Enter a nonempty name without NUL, up to 256 UTF-8 bytes.",
      });
      return;
    }
    const start = parseSelectionTime(currentDraft.start, info.sampleRate, currentDraft.format);
    const end =
      currentDraft.kind === "marker"
        ? start
        : parseSelectionTime(currentDraft.end, info.sampleRate, currentDraft.format);
    if (
      start === undefined ||
      end === undefined ||
      start < 0 ||
      end > info.frames ||
      start > end ||
      (currentDraft.kind === "region" && start === end)
    ) {
      setDraft({
        ...currentDraft,
        error: `Enter valid ${currentDraft.format} within the document${currentDraft.kind === "region" ? ", with end after start" : ""}.`,
      });
      return;
    }
    if (!/^#[0-9a-f]{6}$/i.test(currentDraft.color)) {
      setDraft({ ...currentDraft, error: "Choose a valid color." });
      return;
    }
    const changes = { id: currentDraft.id, name, color: currentDraft.color };
    if (currentDraft.kind === "marker") onUpdateMarker({ ...changes, frame: start });
    else onUpdateRegion({ ...changes, start, end });
    setDraft(undefined);
  };
  const update = (changes: Partial<Draft>) =>
    currentDraft && setDraft({ ...currentDraft, ...changes, error: undefined });
  return (
    <ControlDisclosure
      className="relative text-xs"
      data-testid="timeline-panel"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        className="flex size-7 cursor-pointer list-none items-center justify-center rounded hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
        title="Markers and regions"
      >
        <ListMusic className="size-4" aria-hidden="true" />
        <span className="sr-only">
          Markers and regions ({timeline.markers.length + timeline.regions.length})
        </span>
      </summary>
      {open && (
        <div
          data-disclosure-panel
          className="studio-dialog absolute right-0 top-full z-40 mt-1 max-h-[min(20rem,calc(100dvh-1rem))] w-[32rem] max-w-[calc(100vw-2rem)] overflow-y-auto border p-3 text-popover-foreground"
        >
          <div className="mb-2 flex flex-wrap gap-2 border-b border-border/60 pb-2">
            <Button
              size="xs"
              variant="outline"
              disabled={busy || !onExport}
              onClick={() => !busy && onExport?.("csv")}
            >
              Export CSV
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={busy || !onExport}
              onClick={() => !busy && onExport?.("labels")}
            >
              Export labels
            </Button>
          </div>
          {timeline.markers.length === 0 && timeline.regions.length === 0 && (
            <p className="py-2 text-muted-foreground">No markers or regions.</p>
          )}
          <ul className="space-y-1">
            {timeline.markers.map((marker) => (
              <li
                key={`marker-${marker.id}`}
                className="grid min-w-0 grid-cols-[0.75rem_minmax(0,1fr)] items-start gap-x-2 gap-y-1 rounded-md border border-border/60 px-2 py-2 min-[560px]:grid-cols-[0.75rem_minmax(0,1fr)_auto]"
                data-testid={`marker-row-${marker.id}`}
              >
                <span
                  role="img"
                  className="mt-1 size-3 shrink-0 rounded-sm"
                  style={{ backgroundColor: marker.color }}
                  aria-label={`Color ${marker.color}`}
                />
                <div className="min-w-0">
                  <span className="block break-words font-medium [overflow-wrap:anywhere]">
                    {marker.name}
                  </span>
                  <span className="block break-words text-[11px] tabular-nums text-muted-foreground [overflow-wrap:anywhere]">
                    {formatSelectionTime(marker.frame, info.sampleRate, timeFormat)}
                  </span>
                </div>
                <div className="col-start-2 flex flex-wrap gap-1 min-[560px]:col-start-3 min-[560px]:row-start-1">
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    aria-label={`Jump to marker ${marker.name}`}
                    onClick={() =>
                      !busy && onJump({ ...selection, start: marker.frame, end: marker.frame })
                    }
                  >
                    Jump
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    aria-label={`Edit marker ${marker.name}`}
                    onClick={() => edit("marker", marker)}
                  >
                    Edit
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    aria-label={`Delete marker ${marker.name}`}
                    onClick={() => !busy && onRemoveMarker(marker.id)}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ))}
            {timeline.regions.map((region) => (
              <li
                key={`region-${region.id}`}
                className="grid min-w-0 grid-cols-[0.75rem_minmax(0,1fr)] items-start gap-x-2 gap-y-1 rounded-md border border-border/60 px-2 py-2 min-[560px]:grid-cols-[0.75rem_minmax(0,1fr)_auto]"
                data-testid={`region-row-${region.id}`}
              >
                <span
                  role="img"
                  className="mt-1 size-3 shrink-0 rounded-sm"
                  style={{ backgroundColor: region.color }}
                  aria-label={`Color ${region.color}`}
                />
                <div className="min-w-0">
                  <span className="block break-words font-medium [overflow-wrap:anywhere]">
                    {region.name}
                  </span>
                  <span className="block break-words text-[11px] tabular-nums text-muted-foreground [overflow-wrap:anywhere]">
                    {formatSelectionTime(region.start, info.sampleRate, timeFormat)} –{" "}
                    {formatSelectionTime(region.end, info.sampleRate, timeFormat)}
                  </span>
                </div>
                <div className="col-start-2 flex flex-wrap gap-1 min-[560px]:col-start-3 min-[560px]:row-start-1">
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    aria-label={`Jump to region ${region.name}`}
                    onClick={() =>
                      !busy && onJump({ ...selection, start: region.start, end: region.end })
                    }
                  >
                    Jump
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    aria-label={`Edit region ${region.name}`}
                    onClick={() => edit("region", region)}
                  >
                    Edit
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    aria-label={`Delete region ${region.name}`}
                    onClick={() => !busy && onRemoveRegion(region.id)}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          {currentDraft && (
            <form
              aria-label={`Edit ${currentDraft.kind}`}
              className="studio-section mt-3 grid min-w-0 grid-cols-[minmax(0,1fr)_4rem] items-end gap-x-3 gap-y-2 border p-3"
              onSubmit={(event) => {
                event.preventDefault();
                save();
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setDraft(undefined);
                }
              }}
            >
              <span className="col-span-2 text-[11px] text-muted-foreground">
                Time format: {currentDraft.format}
              </span>
              <label htmlFor={`${id}-name`} className="min-w-0 space-y-1 text-muted-foreground">
                Name
                <input
                  id={`${id}-name`}
                  aria-label="Timeline name"
                  aria-invalid={Boolean(currentDraft.error)}
                  aria-describedby={currentDraft.error ? `${id}-error` : undefined}
                  className="studio-field mt-1 block min-w-0 w-full border px-2 py-1.5 text-foreground"
                  value={currentDraft.name}
                  onChange={(event) => update({ name: event.target.value })}
                  disabled={busy}
                />
              </label>
              <label htmlFor={`${id}-color`} className="space-y-1 text-muted-foreground">
                Color
                <input
                  id={`${id}-color`}
                  aria-label="Timeline color"
                  type="color"
                  className="studio-field mt-1 block h-8 w-full border p-1"
                  value={currentDraft.color}
                  onChange={(event) => update({ color: event.target.value })}
                  disabled={busy}
                />
              </label>
              <div
                className={`col-span-2 grid min-w-0 gap-3 ${currentDraft.kind === "region" ? "grid-cols-2" : "grid-cols-1"}`}
              >
                <label htmlFor={`${id}-start`} className="min-w-0 space-y-1 text-muted-foreground">
                  {currentDraft.kind === "marker" ? "Position" : "Start"}
                  <input
                    id={`${id}-start`}
                    aria-label={currentDraft.kind === "marker" ? "Marker position" : "Region start"}
                    className="studio-field mt-1 block min-w-0 w-full border px-2 py-1.5 tabular-nums text-foreground"
                    value={currentDraft.start}
                    onChange={(event) => update({ start: event.target.value })}
                    aria-invalid={Boolean(currentDraft.error)}
                    aria-describedby={currentDraft.error ? `${id}-error` : undefined}
                    disabled={busy}
                  />
                </label>
                {currentDraft.kind === "region" && (
                  <label htmlFor={`${id}-end`} className="min-w-0 space-y-1 text-muted-foreground">
                    End
                    <input
                      id={`${id}-end`}
                      aria-label="Region end"
                      className="studio-field mt-1 block min-w-0 w-full border px-2 py-1.5 tabular-nums text-foreground"
                      value={currentDraft.end}
                      onChange={(event) => update({ end: event.target.value })}
                      aria-invalid={Boolean(currentDraft.error)}
                      aria-describedby={currentDraft.error ? `${id}-error` : undefined}
                      disabled={busy}
                    />
                  </label>
                )}
              </div>
              <div className="studio-dialog-actions col-span-2 flex flex-wrap justify-end gap-2 border-t pt-2">
                <Button size="xs" type="submit" disabled={busy}>
                  Save {currentDraft.kind}
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  type="button"
                  onClick={() => setDraft(undefined)}
                >
                  Cancel
                </Button>
              </div>
              {currentDraft.error && (
                <p
                  id={`${id}-error`}
                  role="alert"
                  className="col-span-2 break-words text-destructive"
                >
                  {currentDraft.error}
                </p>
              )}
            </form>
          )}
        </div>
      )}
    </ControlDisclosure>
  );
}
