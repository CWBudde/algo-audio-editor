import type { SelectionRange } from "@aae/protocol";
import { type FrameRange, frameToX } from "@/lib/waveform-geometry";

export function TimelineAnchors({
  timeline,
  viewport,
  width,
  disabled,
  selection,
  onSelect: setSelection,
}: {
  timeline: import("@aae/protocol").TimelineResult;
  viewport: FrameRange;
  width: number;
  disabled: boolean;
  selection: SelectionRange;
  onSelect: (range: SelectionRange) => void;
}) {
  return (
    <>
      {timeline.regions.map(
        (region) =>
          region.end >= viewport.start &&
          region.start <= viewport.end && (
            <button
              key={`region-${region.id}`}
              type="button"
              title={region.name}
              aria-label={`Select region ${region.name}`}
              disabled={disabled}
              className="absolute bottom-0 z-10 h-2 min-w-1 rounded"
              data-testid={`timeline-region-${region.id}`}
              style={{
                backgroundColor: `${region.color}80`,
                left: frameToX(Math.max(viewport.start, region.start), viewport, width),
                width: Math.max(
                  1,
                  frameToX(Math.min(viewport.end, region.end), viewport, width) -
                    frameToX(Math.max(viewport.start, region.start), viewport, width),
                ),
              }}
              onClick={() =>
                setSelection({
                  start: region.start,
                  end: region.end,
                  channelMask: selection.channelMask,
                })
              }
            />
          ),
      )}
      {timeline.markers.map(
        (marker) =>
          marker.frame >= viewport.start &&
          marker.frame <= viewport.end && (
            <button
              key={`marker-${marker.id}`}
              type="button"
              title={marker.name}
              aria-label={`Go to marker ${marker.name}`}
              disabled={disabled}
              className="absolute top-0 z-20 h-full border-l-2 text-[10px]"
              data-testid={`timeline-marker-${marker.id}`}
              style={{
                left: Math.min(width - 1, frameToX(marker.frame, viewport, width)),
                borderColor: marker.color,
                color: marker.color,
              }}
              onClick={() =>
                setSelection({
                  start: marker.frame,
                  end: marker.frame,
                  channelMask: selection.channelMask,
                })
              }
            >
              {marker.name}
            </button>
          ),
      )}
    </>
  );
}
