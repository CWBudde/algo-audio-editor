import { useId } from "react";
import {
  ANALYSIS_AVERAGES,
  ANALYSIS_SMOOTHING,
  ANALYSIS_WINDOWS,
  FFT_SIZES,
  type SpectralSettings,
} from "@/lib/analysis-settings";
export function AnalysisControls({
  settings,
  onChange,
  disabled = false,
  showAveraging = true,
}: {
  settings: SpectralSettings;
  onChange(change: Partial<SpectralSettings>): void;
  disabled?: boolean;
  showAveraging?: boolean;
}) {
  const id = useId();
  return (
    <fieldset disabled={disabled} className="flex flex-wrap items-end gap-3 text-xs">
      <legend className="sr-only">Spectral analysis settings</legend>
      <div>
        <label htmlFor={`${id}-fft`}>FFT size</label>
        <select
          id={`${id}-fft`}
          className="ml-2 rounded border bg-background p-1"
          value={settings.fftSize}
          onChange={(e) => onChange({ fftSize: Number(e.target.value) })}
        >
          {FFT_SIZES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={`${id}-window`}>Window</label>
        <select
          id={`${id}-window`}
          className="ml-2 rounded border bg-background p-1"
          value={settings.window}
          onChange={(e) => onChange({ window: e.target.value })}
        >
          {ANALYSIS_WINDOWS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      {showAveraging && (
        <div>
          <label htmlFor={`${id}-average`}>Averaging</label>
          <select
            id={`${id}-average`}
            className="ml-2 rounded border bg-background p-1"
            value={settings.averaging}
            onChange={(e) => onChange({ averaging: Number(e.target.value) })}
          >
            {ANALYSIS_AVERAGES.map((n) => (
              <option key={n} value={n}>
                {n} frame{n > 1 ? "s" : ""}
              </option>
            ))}
          </select>
        </div>
      )}
      <div>
        <label htmlFor={`${id}-smooth`}>Octave smoothing</label>
        <select
          id={`${id}-smooth`}
          className="ml-2 rounded border bg-background p-1"
          value={settings.smoothing}
          onChange={(e) => onChange({ smoothing: Number(e.target.value) })}
        >
          {ANALYSIS_SMOOTHING.map((n) => (
            <option key={n} value={n}>
              {n ? `1/${n} octave` : "None"}
            </option>
          ))}
        </select>
      </div>
    </fieldset>
  );
}
