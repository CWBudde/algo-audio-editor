import type { DocumentInfoResult, ProcessStartParams, SelectionRange } from "@aae/protocol";

export interface ProcessSettings {
  curve: "linear" | "equal-power" | "logarithmic" | "s-curve";
  durationText: string;
  channelMode: "mix" | "left" | "right";
  sampleRateText: string;
  quality: "fast" | "balanced" | "best";
  generator: "silence" | "sine" | "white-noise" | "pink-noise" | "linear-sweep" | "log-sweep";
  frequencyText: string;
  endFrequencyText: string;
  levelText: string;
  seed: number;
  channel: number;
}

export const PROCESS_TITLES: Record<ProcessStartParams["operation"], string> = {
  gain: "Amplify",
  "normalize-peak": "Normalize",
  "normalize-loudness": "Normalize",
  "fade-in": "Fade In / Out",
  "fade-out": "Fade In / Out",
  crossfade: "Crossfade at cursor",
  reverse: "Reverse",
  invert: "Invert polarity",
  "remove-dc": "Remove DC offset",
  "mono-to-stereo": "Mono to stereo",
  "stereo-to-mono": "Stereo to mono",
  resample: "Change sample rate",
  generate: "Generate audio",
  "extract-channel": "Extract channel",
};

export function defaultProcessSettings(info: DocumentInfoResult, seed = 1): ProcessSettings {
  return {
    curve: "linear",
    durationText: "1",
    channelMode: "mix",
    sampleRateText: String(info.sampleRate),
    quality: "balanced",
    generator: "sine",
    frequencyText: "440",
    endFrequencyText: String(Math.min(20000, info.sampleRate / 2)),
    levelText: "-12",
    seed,
    channel: 0,
  };
}

function finite(text: string, minimum: number, maximum: number): number | undefined {
  if (!text.trim()) return;
  const value = Number(text);
  return Number.isFinite(value) && value >= minimum && value <= maximum ? value : undefined;
}

/** Only metadata and parameter validation live here; the kernel owns all DSP. */
export function processParams(
  info: DocumentInfoResult,
  selection: SelectionRange,
  operation: ProcessStartParams["operation"],
  parameterText: string,
  settings: ProcessSettings,
): ProcessStartParams | undefined {
  const base = { documentId: info.documentId, ...selection, operation };
  switch (operation) {
    case "gain": {
      const gainDb = finite(parameterText, -120, 60);
      return gainDb === undefined ? undefined : { ...base, operation, gainDb };
    }
    case "normalize-peak":
    case "normalize-loudness": {
      const target = finite(parameterText, operation === "normalize-peak" ? -120 : -69, 0);
      return target === undefined ? undefined : { ...base, operation, target };
    }
    case "fade-in":
    case "fade-out":
      return { ...base, operation, curve: settings.curve };
    case "crossfade": {
      const duration = finite(settings.durationText, 0, Number.MAX_SAFE_INTEGER / info.sampleRate);
      if (duration === undefined || selection.start !== selection.end) return;
      const durationFrames = Math.round(duration * info.sampleRate);
      if (
        durationFrames < 2 ||
        durationFrames > selection.start ||
        durationFrames > info.frames - selection.end
      )
        return;
      return { ...base, operation, durationFrames, curve: settings.curve };
    }
    case "mono-to-stereo":
      return info.channels === 1 ? { ...base, operation } : undefined;
    case "stereo-to-mono":
      return info.channels === 2
        ? { ...base, operation, channelMode: settings.channelMode }
        : undefined;
    case "resample": {
      const sampleRate = finite(settings.sampleRateText, 8000, 384000);
      return sampleRate === undefined || !Number.isInteger(sampleRate)
        ? undefined
        : { ...base, operation, sampleRate, quality: settings.quality };
    }
    case "generate": {
      const duration = finite(settings.durationText, 0, Number.MAX_SAFE_INTEGER / info.sampleRate);
      const durationFrames =
        selection.end > selection.start
          ? selection.end - selection.start
          : Math.round((duration ?? 0) * info.sampleRate);
      if (!durationFrames || !Number.isSafeInteger(durationFrames)) return;
      const generator = settings.generator;
      const resolved = {
        ...base,
        operation,
        generator,
        durationFrames,
        frequency: 440,
        endFrequency: Math.min(20000, info.sampleRate / 2),
        levelDb: -12,
        seed: settings.seed,
      };
      if (generator === "silence") return { ...resolved, operation, generator };
      const levelDb = finite(settings.levelText, -120, 0);
      if (levelDb === undefined) return;
      if (generator === "white-noise" || generator === "pink-noise")
        return { ...resolved, operation, generator, levelDb };
      const frequency = finite(settings.frequencyText, Number.MIN_VALUE, info.sampleRate / 2);
      if (frequency === undefined) return;
      if (generator === "sine") return { ...resolved, operation, generator, frequency, levelDb };
      const endFrequency = finite(settings.endFrequencyText, Number.MIN_VALUE, info.sampleRate / 2);
      return endFrequency === undefined
        ? undefined
        : { ...resolved, operation, generator, frequency, endFrequency, levelDb };
    }
    case "extract-channel":
      return Number.isInteger(settings.channel) &&
        settings.channel >= 0 &&
        settings.channel < info.channels
        ? { ...base, operation, channel: settings.channel }
        : undefined;
    default:
      return { ...base, operation };
  }
}

export function processSettingsKey(params: ProcessStartParams): string {
  return JSON.stringify(params);
}
