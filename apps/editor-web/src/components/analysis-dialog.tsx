import { useId, useLayoutEffect, useRef } from "react";
import type { AnalysisView } from "@/hooks/use-analysis-dialog";
import { amplitudeDB, meterNumber } from "./playback-meters";

function PitchTrack({ view }: { view: AnalysisView }) {
  const job = view.job;
  const values = job?.data ? new Float64Array(job.data) : undefined;
  const paths = new Map<number, string>();
  let voiced = 0;
  const detail: { channel: number; frame: number; hz: number; confidence: number }[] = [];
  if (values)
    for (let i = 0; i < values.length; i += 4) {
      const channel = values[i],
        frame = values[i + 1],
        hz = values[i + 2];
      if (hz <= 0 || !Number.isFinite(hz)) continue;
      voiced++;
      if (detail.length < 12) detail.push({ channel, frame, hz, confidence: values[i + 3] });
      const x =
        ((frame - (job?.start ?? 0)) / Math.max(1, (job?.end ?? 1) - (job?.start ?? 0))) * 600;
      const y = 150 - Math.max(0, Math.min(1, Math.log2(hz / 40) / Math.log2(2000 / 40))) * 150;
      paths.set(
        channel,
        (paths.get(channel) ?? "") +
          `${paths.has(channel) ? " L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`,
      );
    }
  return (
    <>
      <p className="text-sm">{voiced} voiced frames · frequency in Hz · confidence from YIN</p>
      <svg
        role="img"
        aria-label="Pitch tracking"
        viewBox="0 0 600 160"
        className="mt-3 w-full rounded border"
      >
        <text x="5" y="13" fill="currentColor" fontSize="10">
          2000 Hz
        </text>
        <text x="5" y="150" fill="currentColor" fontSize="10">
          40 Hz
        </text>
        {Array.from(paths, ([channel, path]) => (
          <path
            key={channel}
            data-testid="pitch-track-path"
            d={path}
            fill="none"
            stroke={channel % 2 ? "#f59e0b" : "#22c55e"}
            strokeWidth="1.5"
          />
        ))}
      </svg>
      {!voiced && <p>No confident pitch detected in this range.</p>}
      {detail.length > 0 && (
        <details className="mt-2 text-xs">
          <summary>Pitch measurements (first {detail.length} voiced frames)</summary>
          <table className="w-full text-left">
            <thead>
              <tr>
                <th>Channel</th>
                <th>Time (s)</th>
                <th>Frequency (Hz)</th>
                <th>Confidence</th>
              </tr>
            </thead>
            <tbody>
              {detail.map((row) => (
                <tr key={`${row.channel}-${row.frame}`}>
                  <td>{row.channel + 1}</td>
                  <td>{(row.frame / view.info.sampleRate).toFixed(3)}</td>
                  <td>{row.hz.toFixed(2)}</td>
                  <td>{row.confidence.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </>
  );
}
export function AnalysisDialog({
  view,
  onCancel,
  onCommit,
}: {
  view?: AnalysisView;
  onCancel(): void;
  onCommit(): void;
}) {
  const id = useId(),
    dialog = useRef<HTMLDialogElement>(null),
    opener = useRef<HTMLElement | undefined>(undefined);
  const open = Boolean(view);
  useLayoutEffect(() => {
    if (!open) return;
    opener.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.showModal();
    dialog.current?.querySelector<HTMLElement>("button")?.focus();
    return () => {
      dialog.current?.close();
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    };
  }, [open]);
  const job = view?.job;
  const title =
    view?.kind === "pitch"
      ? "Pitch tracking"
      : view?.kind === "clipping"
        ? "Detect clipping"
        : "Audio statistics";
  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${id}-title`}
      aria-modal="true"
      className="m-auto max-h-[85vh] w-[min(60rem,calc(100vw-2rem))] overflow-auto rounded-lg border bg-popover p-5 text-popover-foreground shadow-xl backdrop:bg-black/50"
      onCancel={(e) => {
        e.preventDefault();
        if (!view?.committing) onCancel();
      }}
    >
      <h2 id={`${id}-title`} className="text-lg font-medium">
        {title}
      </h2>
      {view && (
        <>
          <p className="my-2 text-sm text-muted-foreground">
            {view.info.name} ·{" "}
            {view.selection.start === view.selection.end
              ? "Whole document"
              : `Frames ${view.selection.start}–${view.selection.end}`}{" "}
            · selected channels
          </p>
          {view.error && <p role="alert">{view.error}</p>}
          {view.working && (
            <div role="status">
              <p>{view.committing ? "Adding clipping markers…" : "Analysing audio…"}</p>
              <progress
                aria-label="Analysis progress"
                max={job?.totalFrames ?? 1}
                value={job?.processedFrames ?? 0}
              />
            </div>
          )}
          {!view.working && job && (
            <>
              {view.kind === "statistics" && (
                <>
                  <table className="my-3 w-full text-left text-sm">
                    <thead>
                      <tr>
                        {[
                          "Channel",
                          "Peak (dBFS)",
                          "RMS (dBFS)",
                          "DC offset",
                          "Crest (dB)",
                          "Zero crossings",
                          "Clipped samples",
                        ].map((label) => (
                          <th key={label} className="p-2">
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {job.statistics?.map((row) => (
                        <tr key={row.channel}>
                          <th className="p-2">{row.channel + 1}</th>
                          <td>{meterNumber(amplitudeDB(row.peak), "")}</td>
                          <td>{meterNumber(amplitudeDB(row.rms), "")}</td>
                          <td>{row.dc.toFixed(6)}</td>
                          <td>{row.crestDB?.toFixed(2) ?? "—"}</td>
                          <td>{row.zeroCrossings}</td>
                          <td>{row.clippedSamples}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p>
                    Integrated loudness:{" "}
                    {job.integratedLUFS === null
                      ? "Below measurement gate"
                      : meterNumber(job.integratedLUFS, "LUFS")}
                  </p>
                </>
              )}
              {view.kind === "pitch" && <PitchTrack view={view} />}
              {view.kind === "clipping" && (
                <p>
                  {job.markerCount ?? 0} clipped regions detected. Adding their markers creates one
                  undoable history entry.
                </p>
              )}
            </>
          )}
          <div className="mt-4 flex justify-end gap-2">
            {view.kind === "clipping" && (
              <button
                type="button"
                className="rounded bg-primary px-3 py-2 text-primary-foreground"
                disabled={view.working || !job?.markerCount}
                onClick={onCommit}
              >
                Add clipping markers
              </button>
            )}
            <button
              type="button"
              className="rounded border px-3 py-2"
              disabled={view.committing}
              onClick={onCancel}
            >
              {view.working ? "Cancel analysis" : "Close analysis"}
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}
