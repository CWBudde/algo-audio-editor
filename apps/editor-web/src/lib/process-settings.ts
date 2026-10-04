import type {
  DocumentInfoResult,
  ProcessStartParams,
  SelectionRange,
  SelectionResult,
  SpectralMask,
} from "@aae/protocol";

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
  spectralMask?: SpectralMask;
  noiseProfile?: SelectionResult;
  fftSize: number;
  reductionText: string;
  noiseMethod: "wiener" | "subtraction" | "gate";
  sensitivityText: string;
  thresholdText: string;
  maxGapText: string;
  ratioText: string;
  humHz: 50 | 60;
  humQText: string;
  harmonicsText: string;
}

export const PROCESS_TITLES: Record<ProcessStartParams["operation"], string> = {
  "spectral-attenuate": "Attenuate spectral selection",
  "spectral-remove": "Remove spectral selection",
  "spectral-heal": "Heal spectral selection",
  "noise-reduce": "Noise reduction",
  "remove-clicks": "Remove clicks and pops",
  declip: "Repair clipped audio",
  "time-stretch": "Time stretch",
  "remove-hum": "Remove mains hum",
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
    fftSize: 2048,
    reductionText: "24",
    noiseMethod: "wiener",
    sensitivityText: "8",
    thresholdText: "0.99",
    maxGapText: "64",
    ratioText: "1.25",
    humHz: 50,
    humQText: "30",
    harmonicsText: "8",
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
    case "spectral-attenuate":
    case "spectral-remove":
    case "spectral-heal": {
      const mask = settings.spectralMask;
      if (![256, 512, 1024, 2048, 4096, 8192].includes(settings.fftSize)) return;
      const gainDb = operation === "spectral-attenuate" ? finite(parameterText, -120, 0) : 0;
      if (
        !mask ||
        ![mask.start, mask.end, mask.lowHz, mask.highHz].every(Number.isFinite) ||
        !Number.isSafeInteger(mask.start) ||
        !Number.isSafeInteger(mask.end) ||
        (mask.points &&
          (mask.points.length < 3 ||
            mask.points.length > 128 ||
            mask.points.some((p) => !Number.isFinite(p.frame) || !Number.isFinite(p.hz)))) ||
        mask.start !== selection.start ||
        mask.end !== selection.end ||
        mask.end <= mask.start ||
        mask.end > info.frames ||
        mask.lowHz < 0 ||
        mask.highHz > info.sampleRate / 2 ||
        mask.highHz <= mask.lowHz ||
        gainDb === undefined
      )
        return;
      if (
        operation === "spectral-heal" &&
        (mask.end - mask.start > 256 || mask.start < 2 || mask.end > info.frames - 2)
      )
        return;
      return { ...base, operation, spectralMask: mask, fftSize: settings.fftSize, gainDb };
    }
    case "noise-reduce": {
      const noiseProfile = settings.noiseProfile;
      if (![256, 512, 1024, 2048, 4096, 8192].includes(settings.fftSize)) return;
      const reductionDb = finite(settings.reductionText, 0, 60);
      if (
        !noiseProfile ||
        !Number.isSafeInteger(noiseProfile.start) ||
        !Number.isSafeInteger(noiseProfile.end) ||
        noiseProfile.start < 0 ||
        noiseProfile.end > info.frames ||
        noiseProfile.documentId !== info.documentId ||
        noiseProfile.end - noiseProfile.start < settings.fftSize / 2 ||
        (noiseProfile.channelMask & selection.channelMask) !== selection.channelMask ||
        reductionDb === undefined
      )
        return;
      return {
        ...base,
        operation,
        noiseProfile,
        fftSize: settings.fftSize,
        reductionDb,
        noiseMethod: settings.noiseMethod,
      };
    }
    case "remove-clicks": {
      const sensitivity = finite(settings.sensitivityText, 3, 30),
        maxGap = finite(settings.maxGapText, 1, 256);
      return sensitivity === undefined || maxGap === undefined || !Number.isInteger(maxGap)
        ? undefined
        : { ...base, operation, sensitivity, maxGap };
    }
    case "declip": {
      const clipThreshold = finite(settings.thresholdText, 0.1, 1),
        maxGap = finite(settings.maxGapText, 1, 256);
      return clipThreshold === undefined || maxGap === undefined || !Number.isInteger(maxGap)
        ? undefined
        : { ...base, operation, clipThreshold, maxGap };
    }
    case "time-stretch": {
      const durationRatio = finite(settings.ratioText, 0.25, 4);
      return durationRatio === undefined || selection.channelMask !== 2 ** info.channels - 1
        ? undefined
        : { ...base, operation, durationRatio };
    }
    case "remove-hum": {
      const humQ = finite(settings.humQText, 5, 100),
        harmonics = finite(settings.harmonicsText, 1, 16);
      return humQ === undefined || harmonics === undefined || !Number.isInteger(harmonics)
        ? undefined
        : { ...base, operation, humHz: settings.humHz, humQ, harmonics };
    }
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
