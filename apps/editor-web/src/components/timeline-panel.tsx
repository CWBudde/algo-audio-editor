import type {
  DocumentInfoResult,
  MarkerUpdateParams,
  RegionUpdateParams,
  SelectionRange,
  TimelineMarker,
  TimelineRegion,
  TimelineResult,
} from "@aae/protocol";
import { ListMusic } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { ControlDisclosure } from "@/components/control-disclosure";
import { Button } from "@/components/ui/button";
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
          className="absolute right-0 top-full z-40 max-h-80 w-[32rem] max-w-[calc(100vw-2rem)] overflow-auto rounded border bg-popover p-3 shadow-lg"
        >
          <div className="mb-2 flex gap-2">
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
            <p>No markers or regions.</p>
          )}
          <ul className="space-y-1">
            {timeline.markers.map((marker) => (
              <li
                key={`marker-${marker.id}`}
                className="flex flex-wrap items-center gap-2"
                data-testid={`marker-row-${marker.id}`}
              >
                <span
                  role="img"
                  className="h-3 w-3 rounded"
                  style={{ backgroundColor: marker.color }}
                  aria-label={`Color ${marker.color}`}
                />
                <span>{marker.name}</span>
                <span className="tabular-nums">
                  {formatSelectionTime(marker.frame, info.sampleRate, timeFormat)}
                </span>
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
              </li>
            ))}
            {timeline.regions.map((region) => (
              <li
                key={`region-${region.id}`}
                className="flex flex-wrap items-center gap-2"
                data-testid={`region-row-${region.id}`}
              >
                <span
                  role="img"
                  className="h-3 w-3 rounded"
                  style={{ backgroundColor: region.color }}
                  aria-label={`Color ${region.color}`}
                />
                <span>{region.name}</span>
                <span className="tabular-nums">
                  {formatSelectionTime(region.start, info.sampleRate, timeFormat)} –{" "}
                  {formatSelectionTime(region.end, info.sampleRate, timeFormat)}
                </span>
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
              </li>
            ))}
          </ul>
          {currentDraft && (
            <form
              aria-label={`Edit ${currentDraft.kind}`}
              className="mt-2 flex flex-wrap items-end gap-2"
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
              <span className="w-full text-muted-foreground">
                Time format: {currentDraft.format}
              </span>
              <label htmlFor={`${id}-name`}>
                Name
                <input
                  id={`${id}-name`}
                  aria-label="Timeline name"
                  aria-invalid={Boolean(currentDraft.error)}
                  aria-describedby={currentDraft.error ? `${id}-error` : undefined}
                  className="block rounded border bg-background px-1"
                  value={currentDraft.name}
                  onChange={(event) => update({ name: event.target.value })}
                  disabled={busy}
                />
              </label>
              <label htmlFor={`${id}-color`}>
                Color
                <input
                  id={`${id}-color`}
                  aria-label="Timeline color"
                  type="color"
                  value={currentDraft.color}
                  onChange={(event) => update({ color: event.target.value })}
                  disabled={busy}
                />
              </label>
              <label htmlFor={`${id}-start`}>
                {currentDraft.kind === "marker" ? "Position" : "Start"}
                <input
                  id={`${id}-start`}
                  aria-label={currentDraft.kind === "marker" ? "Marker position" : "Region start"}
                  className="block rounded border bg-background px-1 tabular-nums"
                  value={currentDraft.start}
                  onChange={(event) => update({ start: event.target.value })}
                  aria-invalid={Boolean(currentDraft.error)}
                  aria-describedby={currentDraft.error ? `${id}-error` : undefined}
                  disabled={busy}
                />
              </label>
              {currentDraft.kind === "region" && (
                <label htmlFor={`${id}-end`}>
                  End
                  <input
                    id={`${id}-end`}
                    aria-label="Region end"
                    className="block rounded border bg-background px-1 tabular-nums"
                    value={currentDraft.end}
                    onChange={(event) => update({ end: event.target.value })}
                    aria-invalid={Boolean(currentDraft.error)}
                    aria-describedby={currentDraft.error ? `${id}-error` : undefined}
                    disabled={busy}
                  />
                </label>
              )}
              <Button size="xs" type="submit" disabled={busy}>
                Save {currentDraft.kind}
              </Button>
              <Button size="xs" variant="outline" type="button" onClick={() => setDraft(undefined)}>
                Cancel
              </Button>
              {currentDraft.error && (
                <p id={`${id}-error`} role="alert" className="w-full text-destructive">
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
