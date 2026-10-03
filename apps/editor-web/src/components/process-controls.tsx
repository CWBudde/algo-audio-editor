import type { ProcessOperation, ProcessView } from "@/hooks/use-process";
import { defaultProcessSettings, type ProcessSettings } from "@/lib/process-settings";

interface Props {
  view: ProcessView;
  disabled: boolean;
  onOperationChange(value: ProcessOperation): void;
  onSettingsChange(value: Partial<ProcessSettings>): void;
}

const fieldClass = "mt-1 w-full rounded border bg-background px-3 py-2";
const channelChoices = [0, 1, 2, 3, 4, 5, 6, 7] as const;

export function ProcessControls({ view, disabled, onOperationChange, onSettingsChange }: Props) {
  const settings = view.settings ?? defaultProcessSettings(view.info);
  const operation = view.operation;
  const input = (label: string, value: string, field: keyof ProcessSettings, locked = false) => (
    <label className="mt-3 block text-sm">
      {label}
      <input
        aria-label={label}
        type="text"
        inputMode="decimal"
        value={value}
        disabled={disabled || locked}
        className={fieldClass}
        onChange={(event) => onSettingsChange({ [field]: event.target.value })}
      />
    </label>
  );
  const fade = operation === "fade-in" || operation === "fade-out" || operation === "crossfade";
  const generator = settings.generator;
  return (
    <>
      {fade && (
        <>
          {operation !== "crossfade" && (
            <label className="mt-3 block text-sm">
              Direction
              <select
                aria-label="Direction"
                className={fieldClass}
                disabled={disabled}
                value={operation}
                onChange={(event) =>
                  onOperationChange(event.target.value === "fade-out" ? "fade-out" : "fade-in")
                }
              >
                <option value="fade-in">Fade in</option>
                <option value="fade-out">Fade out</option>
              </select>
            </label>
          )}
          <label className="mt-3 block text-sm">
            Curve
            <select
              aria-label="Curve"
              className={fieldClass}
              disabled={disabled}
              value={settings.curve}
              onChange={(event) =>
                onSettingsChange({ curve: event.target.value as ProcessSettings["curve"] })
              }
            >
              <option value="linear">Linear</option>
              <option value="equal-power">Equal power</option>
              <option value="logarithmic">Logarithmic</option>
              <option value="s-curve">S-curve</option>
            </select>
          </label>
          {operation === "crossfade" && (
            <>
              {input("Overlap duration (seconds)", settings.durationText, "durationText")}
              <p className="mt-2 text-xs text-muted-foreground">
                Combine this duration before and after the cursor across all channels. The document
                shortens by one overlap duration.
              </p>
            </>
          )}
        </>
      )}
      {(operation === "mono-to-stereo" ||
        operation === "stereo-to-mono" ||
        operation === "resample") && <p className="mt-3 text-sm">Processes the whole document.</p>}
      {operation === "stereo-to-mono" && (
        <label className="mt-3 block text-sm">
          Mono source
          <select
            aria-label="Mono source"
            className={fieldClass}
            disabled={disabled}
            value={settings.channelMode}
            onChange={(event) =>
              onSettingsChange({
                channelMode: event.target.value as ProcessSettings["channelMode"],
              })
            }
          >
            <option value="mix">Average left and right</option>
            <option value="left">Left</option>
            <option value="right">Right</option>
          </select>
        </label>
      )}
      {operation === "resample" && (
        <>
          {input("Sample rate (Hz)", settings.sampleRateText, "sampleRateText")}
          <label className="mt-3 block text-sm">
            Quality
            <select
              aria-label="Quality"
              className={fieldClass}
              disabled={disabled}
              value={settings.quality}
              onChange={(event) =>
                onSettingsChange({ quality: event.target.value as ProcessSettings["quality"] })
              }
            >
              <option value="fast">Fast</option>
              <option value="balanced">Balanced</option>
              <option value="best">Best</option>
            </select>
          </label>
        </>
      )}
      {operation === "extract-channel" && (
        <>
          <label className="mt-3 block text-sm">
            Channel
            <select
              aria-label="Channel"
              className={fieldClass}
              disabled={disabled}
              value={settings.channel}
              onChange={(event) => onSettingsChange({ channel: Number(event.target.value) })}
            >
              {channelChoices.slice(0, view.info.channels).map((channel) => (
                <option key={channel} value={channel}>
                  Channel {channel + 1}
                </option>
              ))}
            </select>
          </label>
          <p className="mt-2 text-xs text-muted-foreground">
            Open the extracted range in a new unsaved editor window.
          </p>
        </>
      )}
      {operation === "generate" && (
        <>
          <label className="mt-3 block text-sm">
            Generator
            <select
              aria-label="Generator"
              className={fieldClass}
              disabled={disabled}
              value={generator}
              onChange={(event) =>
                onSettingsChange({ generator: event.target.value as ProcessSettings["generator"] })
              }
            >
              <option value="silence">Silence</option>
              <option value="sine">Sine tone</option>
              <option value="white-noise">White noise</option>
              <option value="pink-noise">Pink noise</option>
              <option value="linear-sweep">Linear sweep</option>
              <option value="log-sweep">Logarithmic sweep</option>
            </select>
          </label>
          {view.selection.start === view.selection.end ? (
            input("Duration (seconds)", settings.durationText, "durationText")
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              Replace the selected{" "}
              {(view.selection.end - view.selection.start) / view.info.sampleRate} seconds.
            </p>
          )}
          {(generator === "sine" || generator === "linear-sweep" || generator === "log-sweep") &&
            input(
              generator === "sine" ? "Frequency (Hz)" : "Start frequency (Hz)",
              settings.frequencyText,
              "frequencyText",
            )}
          {(generator === "linear-sweep" || generator === "log-sweep") &&
            input("End frequency (Hz)", settings.endFrequencyText, "endFrequencyText")}
          {generator !== "silence" && input("Level (dBFS)", settings.levelText, "levelText")}
          {(generator === "white-noise" || generator === "pink-noise") && (
            <p className="mt-2 text-xs text-muted-foreground">
              Preview and Apply use the same noise seed. Each channel has its own noise stream.
            </p>
          )}
        </>
      )}
    </>
  );
}
