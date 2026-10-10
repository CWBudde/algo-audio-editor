import { useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { usePreferences } from "@/hooks/use-preferences";
import { useRestoringModal } from "@/hooks/use-restoring-modal";
import type { ExportDitherPreference, ExportFormatPreference } from "@/lib/preferences";
import type { TimeFormat } from "@/lib/waveform-geometry";

const SNAP_OPTIONS = [
  ["zero", "Snap to zero crossings"],
  ["markers", "Snap to markers / regions"],
  ["ticks", "Snap to ruler ticks"],
] as const;

/** Editor-wide settings, saved as soon as they change. */
export function PreferencesDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const id = useId();
  const firstField = useRef<HTMLSelectElement>(null);
  const dialog = useRestoringModal(open, firstField);
  const [preferences, update] = usePreferences();
  const field = "studio-field mt-1 w-full border px-3 py-2 text-sm text-foreground";
  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${id}-title`}
      aria-modal="true"
      data-testid="preferences-dialog"
      className="studio-dialog m-auto max-h-[calc(100dvh-2rem)] w-[min(28rem,calc(100vw-2rem))] overflow-y-auto border p-5 text-popover-foreground backdrop:bg-background/75 backdrop:backdrop-blur-[2px]"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={() => {
        if (!dialog.current?.open) onClose();
      }}
    >
      <h2 id={`${id}-title`} className="studio-dialog-heading text-lg font-semibold tracking-tight">
        Preferences
      </h2>
      <p className="studio-dialog-help mt-1 text-xs text-muted-foreground">
        Changes are saved right away and kept for the next session.
      </p>
      {/* Mounted only while open, so its labels never shadow the waveform's own controls. */}
      {open && (
        <>
          <section
            aria-labelledby={`${id}-export`}
            className="studio-section mt-3 border px-3 py-2"
          >
            <h3 id={`${id}-export`} className="text-xs font-medium text-muted-foreground">
              Export
            </h3>
            <label className="mt-2 block text-xs font-medium text-muted-foreground">
              Default export format
              <select
                ref={firstField}
                value={preferences.exportFormat}
                className={field}
                onChange={(event) =>
                  update({ exportFormat: event.target.value as ExportFormatPreference })
                }
              >
                <option value="source">Same as the source (FLAC/AIFF, otherwise WAV)</option>
                <option value="wav">WAV</option>
                <option value="flac">FLAC</option>
                <option value="aiff">AIFF</option>
              </select>
            </label>
            <label className="mt-2 block text-xs font-medium text-muted-foreground">
              Default dither
              <select
                value={preferences.exportDither}
                className={field}
                onChange={(event) =>
                  update({ exportDither: event.target.value as ExportDitherPreference })
                }
              >
                <option value="auto">Automatic (TPDF when reducing to 16 bits or fewer)</option>
                <option value="none">None</option>
                <option value="rectangular">Rectangular</option>
                <option value="triangular">Triangular (TPDF)</option>
                <option value="gaussian">Gaussian</option>
                <option value="fast-gaussian">Fast Gaussian</option>
              </select>
            </label>
            <p className="mt-2 text-xs text-muted-foreground">
              Save keeps the source format without dither.
            </p>
          </section>
          <section
            aria-labelledby={`${id}-waveform`}
            className="studio-section mt-3 border px-3 py-2"
          >
            <h3 id={`${id}-waveform`} className="text-xs font-medium text-muted-foreground">
              Waveform
            </h3>
            <label className="mt-2 block text-xs font-medium text-muted-foreground">
              Time format
              <select
                value={preferences.timeFormat}
                className={field}
                onChange={(event) => update({ timeFormat: event.target.value as TimeFormat })}
              >
                <option value="samples">Samples</option>
                <option value="seconds">Seconds</option>
                <option value="hms">Hours:minutes:seconds</option>
              </select>
            </label>
            <div className="mt-2 grid gap-1 text-sm">
              {SNAP_OPTIONS.map(([key, label]) => (
                <label key={key} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={preferences.snap[key]}
                    onChange={(event) =>
                      update({ snap: { ...preferences.snap, [key]: event.target.checked } })
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
          </section>
        </>
      )}
      <div className="studio-dialog-actions mt-4 flex justify-end border-t pt-3">
        <Button onClick={onClose}>Close</Button>
      </div>
    </dialog>
  );
}
