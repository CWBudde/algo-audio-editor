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
    <fieldset disabled={disabled} className="flex min-w-0 flex-wrap items-end gap-2 text-[11px]">
      <legend className="sr-only">Spectral analysis settings</legend>
      <div className="flex min-w-0 flex-col gap-1">
        <label className="text-[10px] text-muted-foreground" htmlFor={`${id}-fft`}>
          FFT size
        </label>
        <select
          id={`${id}-fft`}
          className="studio-field h-7 min-w-0 max-w-full border px-2 py-1"
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
      <div className="flex min-w-0 flex-col gap-1">
        <label className="text-[10px] text-muted-foreground" htmlFor={`${id}-window`}>
          Window
        </label>
        <select
          id={`${id}-window`}
          className="studio-field h-7 min-w-0 max-w-full border px-2 py-1"
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
        <div className="flex min-w-0 flex-col gap-1">
          <label className="text-[10px] text-muted-foreground" htmlFor={`${id}-average`}>
            Averaging
          </label>
          <select
            id={`${id}-average`}
            className="studio-field h-7 min-w-0 max-w-full border px-2 py-1"
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
      <div className="flex min-w-0 flex-col gap-1">
        <label className="text-[10px] text-muted-foreground" htmlFor={`${id}-smooth`}>
          Octave smoothing
        </label>
        <select
          id={`${id}-smooth`}
          className="studio-field h-7 min-w-0 max-w-full border px-2 py-1"
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
