import {
  type DocumentInfoResult,
  MAX_SPEECH_TEXT_LENGTH,
  type SelectionRange,
} from "@aae/protocol";
import type { SpeechCatalog, SpeechCatalogModel, SpeechSynthesisParams } from "@/speech/messages";

/** The dialog's text fields; parsed into speech.generate parameters on demand. */
export interface SpeechForm {
  model: string;
  voice: string;
  text: string;
  temperatureText: string;
  samplerStepsText: string;
  eosThresholdText: string;
  seedText: string;
  levelText: string;
}

export const SPEECH_CREDIT_URL = "https://huggingface.co/kyutai/pocket-tts";
export const MAX_SPEECH_SEED = 0xffff_ffff;

export function randomSpeechSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
}

export function emptySpeechForm(seed = randomSpeechSeed()): SpeechForm {
  return {
    model: "",
    voice: "",
    text: "",
    temperatureText: "0.3",
    samplerStepsText: "1",
    eosThresholdText: "-4",
    seedText: String(seed),
    levelText: "0",
  };
}

/**
 * Switches to `model` with its default voice and temperature. Text the user
 * wrote stays; an empty field or another model's sample text becomes this
 * model's sample text, so a language switch does not keep the wrong language.
 */
export function speechModelDefaults(
  form: SpeechForm,
  model: SpeechCatalogModel,
  catalog: SpeechCatalog,
): SpeechForm {
  const sample = !form.text.trim() || catalog.models.some((m) => m.default_text === form.text);
  return {
    ...form,
    model: model.name,
    voice: model.voices.some((voice) => voice.id === model.default_voice)
      ? model.default_voice
      : (model.voices[0]?.id ?? ""),
    temperatureText: String(model.default_temperature),
    text: sample ? model.default_text : form.text,
  };
}

/** Restores a remembered form against the catalog, defaulting what it no longer offers. */
export function speechFormForCatalog(form: SpeechForm, catalog: SpeechCatalog): SpeechForm {
  const model =
    catalog.models.find((candidate) => candidate.name === form.model) ??
    catalog.models.find((candidate) => candidate.name === catalog.default) ??
    catalog.models[0];
  if (!model) return form;
  if (model.name !== form.model) return speechModelDefaults(form, model, catalog);
  return model.voices.some((voice) => voice.id === form.voice)
    ? form
    : { ...form, voice: model.default_voice };
}

export function speechTextLength(text: string): number {
  return [...text].length;
}

export type SpeechFieldError =
  | "text"
  | "temperature"
  | "samplerSteps"
  | "eosThreshold"
  | "seed"
  | "level"
  | "model";

function number(text: string): number | undefined {
  if (!text.trim()) return;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

/** Validates like internal/speech.Validate; the first invalid field, or the parameters. */
export function speechParams(
  form: SpeechForm,
  catalog: SpeechCatalog | undefined,
):
  | { params: SpeechSynthesisParams; error?: undefined }
  | { params?: undefined; error: SpeechFieldError } {
  const model = catalog?.models.find((candidate) => candidate.name === form.model);
  if (!model?.voices.some((voice) => voice.id === form.voice)) return { error: "model" };
  const length = speechTextLength(form.text);
  if (!length || length > MAX_SPEECH_TEXT_LENGTH || ![...form.text].some((c) => c > " "))
    return { error: "text" };
  const temperature = number(form.temperatureText);
  if (temperature === undefined || temperature < 0 || temperature > 2)
    return { error: "temperature" };
  const samplerSteps = number(form.samplerStepsText);
  if (
    samplerSteps === undefined ||
    !Number.isInteger(samplerSteps) ||
    samplerSteps < 1 ||
    samplerSteps > 64
  )
    return { error: "samplerSteps" };
  const eosThreshold = number(form.eosThresholdText);
  if (eosThreshold === undefined) return { error: "eosThreshold" };
  const seed = number(form.seedText);
  if (seed === undefined || !Number.isInteger(seed) || seed < 0 || seed > MAX_SPEECH_SEED)
    return { error: "seed" };
  const levelDb = number(form.levelText);
  if (levelDb === undefined || levelDb < -120 || levelDb > 0) return { error: "level" };
  return {
    params: {
      model: form.model,
      voice: form.voice,
      text: form.text,
      temperature,
      samplerSteps,
      eosThreshold,
      seed,
      levelDb,
    },
  };
}

/** Same request, same candidate: the key a Generate result is reused under. */
export function speechKey(params: SpeechSynthesisParams): string {
  return JSON.stringify([
    params.model,
    params.voice,
    params.text,
    params.temperature,
    params.samplerSteps,
    params.eosThreshold,
    params.seed,
    params.levelDb ?? 0,
  ]);
}

/** m:ss.mmm, minutes unbounded. */
export function formatSpeechTime(frame: number, sampleRate: number): string {
  const millis = Math.round((frame / sampleRate) * 1000);
  const minutes = Math.floor(millis / 60_000);
  const seconds = Math.floor((millis % 60_000) / 1000);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(millis % 1000).padStart(3, "0")}`;
}

function channelNames(mask: number, channels: number): string {
  const all = 2 ** channels - 1;
  if (mask === all)
    return channels === 1 ? "mono" : channels === 2 ? "both channels" : "all channels";
  if (channels === 2) return mask === 1 ? "left" : "right";
  const selected = Array.from({ length: channels }, (_, index) => index)
    .filter((index) => mask & (1 << index))
    .map((index) => index + 1);
  return `channel${selected.length === 1 ? "" : "s"} ${selected.join(", ")}`;
}

/** Where Generate puts the speech, in the dialog's words. */
export function speechPlacement(info: DocumentInfoResult, selection: SelectionRange): string {
  if (!info.frames) return "Creates audio in the empty document";
  const channels = channelNames(selection.channelMask, info.channels);
  if (selection.start === selection.end)
    return `Inserts at ${formatSpeechTime(selection.start, info.sampleRate)} (${channels})`;
  return `Replaces ${formatSpeechTime(selection.start, info.sampleRate)}–${formatSpeechTime(selection.end, info.sampleRate)} (${channels})`;
}
