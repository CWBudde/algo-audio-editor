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
      {operation.startsWith("spectral-") && (
        <p className="mt-3 text-sm">
          {settings.spectralMask
            ? `${settings.spectralMask.lowHz.toFixed(1)}–${settings.spectralMask.highHz.toFixed(1)} Hz · ${settings.spectralMask.points?.length ? "lasso" : "rectangle"}`
            : "Draw a spectral selection first."}
          {operation === "spectral-heal" &&
            " Heal supports short damage up to 256 samples with intact audio on both sides."}
        </p>
      )}
      {operation.startsWith("spectral-") &&
        settings.spectralMask &&
        !settings.spectralMask.points?.length &&
        (["lowHz", "highHz"] as const).map((field) => (
          <label key={field} className="mt-3 block text-sm">
            {field === "lowHz" ? "Lower frequency (Hz)" : "Upper frequency (Hz)"}
            <input
              type="number"
              step="any"
              min="0"
              max={view.info.sampleRate / 2}
              disabled={disabled}
              className={fieldClass}
              value={
                Number.isFinite(settings.spectralMask?.[field])
                  ? settings.spectralMask?.[field]
                  : ""
              }
              onChange={(event) => {
                if (settings.spectralMask)
                  onSettingsChange({
                    spectralMask: {
                      ...settings.spectralMask,
                      [field]: event.target.valueAsNumber,
                    },
                  });
              }}
            />
          </label>
        ))}
      {operation === "noise-reduce" && (
        <>
          <p className="mt-3 text-sm">
            Noise profile: frames {settings.noiseProfile?.start}–{settings.noiseProfile?.end}.
            Capture a noise-only selection before processing.
          </p>
          {input("Maximum reduction (dB)", settings.reductionText, "reductionText")}
          <label className="mt-3 block text-sm">
            Method
            <select
              aria-label="Noise reduction method"
              className={fieldClass}
              disabled={disabled}
              value={settings.noiseMethod}
              onChange={(event) =>
                onSettingsChange({
                  noiseMethod: event.target.value as ProcessSettings["noiseMethod"],
                })
              }
            >
              <option value="wiener">Wiener (smooth)</option>
              <option value="subtraction">Spectral subtraction</option>
              <option value="gate">Spectral gate</option>
            </select>
          </label>
        </>
      )}
      {operation === "remove-clicks" &&
        input("Click sensitivity", settings.sensitivityText, "sensitivityText")}
      {operation === "declip" &&
        input("Clipping threshold (linear)", settings.thresholdText, "thresholdText")}
      {(operation === "remove-clicks" || operation === "declip") && (
        <>
          {input("Maximum repair length (samples)", settings.maxGapText, "maxGapText")}
          <p className="mt-2 text-xs text-muted-foreground">
            Repair interior damage with intact context. Long or edge damage stays unchanged. Preview
            to check intentional transients.
          </p>
        </>
      )}
      {operation === "time-stretch" && (
        <>
          {input("Duration multiplier", settings.ratioText, "ratioText")}
          <p className="mt-2 text-xs text-muted-foreground">
            1.25 makes the selected audio 25% longer while retaining pitch. All channels move
            together; markers and regions follow the new timing.
          </p>
        </>
      )}
      {operation === "remove-hum" && (
        <>
          <label className="mt-3 block text-sm">
            Mains frequency
            <select
              aria-label="Mains frequency"
              className={fieldClass}
              disabled={disabled}
              value={settings.humHz}
              onChange={(event) =>
                onSettingsChange({ humHz: Number(event.target.value) as 50 | 60 })
              }
            >
              <option value="50">50 Hz</option>
              <option value="60">60 Hz</option>
            </select>
          </label>
          {input("Harmonics", settings.harmonicsText, "harmonicsText")}
          {input("Notch Q", settings.humQText, "humQText")}
        </>
      )}
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
