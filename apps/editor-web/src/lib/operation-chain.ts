import {
  CHAIN_SPEECH_GENERATE,
  type DocumentInfoResult,
  type EditApplyParams,
  type EffectPreviewParams,
  MAX_SPEECH_TEXT_LENGTH,
  type OperationChain,
  type ProcessStartParams,
  type RecordedOperation,
  type SpeechGenerateParams,
} from "@aae/protocol";
import { SPEAKABLE } from "@/lib/speech-settings";

export const MAX_CHAIN_OPERATIONS = 64;
export const MAX_CHAIN_BYTES = 1024 * 1024;
export type AppliedOperation =
  | { method: "edit.apply"; params: EditApplyParams }
  | { method: "process.start"; params: ProcessStartParams }
  | { method: "effects.apply"; params: EffectPreviewParams }
  | { method: typeof CHAIN_SPEECH_GENERATE; params: SpeechGenerateParams };

const common = ["start", "end", "channelMask"];
const fields = {
  "edit.apply": [...common, "operation", "frames", "convert", "clipboardVersion"],
  "process.start": [
    ...common,
    "operation",
    "gainDb",
    "target",
    "curve",
    "durationFrames",
    "channelMode",
    "channel",
    "sampleRate",
    "quality",
    "generator",
    "frequency",
    "endFrequency",
    "levelDb",
    "seed",
    "fftSize",
    "spectralMask",
    "noiseProfile",
    "reductionDb",
    "noiseMethod",
    "sensitivity",
    "clipThreshold",
    "maxGap",
    "durationRatio",
    "humHz",
    "humQ",
    "harmonics",
  ],
  "effects.apply": [...common, "graph", "wet", "bypass", "previewId"],
  [CHAIN_SPEECH_GENERATE]: [
    ...common,
    "model",
    "voice",
    "text",
    "temperature",
    "samplerSteps",
    "eosThreshold",
    "seed",
    "levelDb",
  ],
};
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Error(`Unknown chain field: ${key}`);
}

/** Mirrors internal/speech.Validate apart from the catalog lookup, which the speech worker does. */
function validateSpeech(params: Record<string, unknown>) {
  const { model, voice, text, temperature, samplerSteps, eosThreshold, seed, levelDb } = params;
  if (typeof model !== "string" || !model || typeof voice !== "string" || !voice)
    throw new Error("Speech needs a model and a voice.");
  if (typeof text !== "string" || !SPEAKABLE.test(text)) throw new Error("Speech text is empty.");
  if ([...text].length > MAX_SPEECH_TEXT_LENGTH)
    throw new Error(`Speech text exceeds ${MAX_SPEECH_TEXT_LENGTH} characters.`);
  if (typeof temperature !== "number" || temperature < 0 || temperature > 2)
    throw new Error("Speech temperature must be from 0 to 2.");
  if (!Number.isInteger(samplerSteps) || Number(samplerSteps) < 1 || Number(samplerSteps) > 64)
    throw new Error("Speech sampler steps must be a whole number from 1 to 64.");
  if (typeof eosThreshold !== "number") throw new Error("Speech EOS threshold must be a number.");
  if (!Number.isSafeInteger(seed) || Number(seed) < 0)
    throw new Error("Speech seed must be a non-negative whole number.");
  if (levelDb !== undefined && (typeof levelDb !== "number" || levelDb < -120 || levelDb > 0))
    throw new Error("Speech level must be from -120 to 0 dB.");
}

/** A short name for a chain step, as the automation and batch dialogs list it. */
export function describeOperation(operation: RecordedOperation): string {
  if (operation.method === "effects.apply") return "Effects";
  if (operation.method === CHAIN_SPEECH_GENERATE) return "Speech";
  return operation.params.operation;
}

function finiteControl(value: unknown, depth = 0) {
  if (depth > 32) throw new Error("Chain nesting exceeds 32 levels.");
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error("Chain numbers must be finite.");
  if (value !== null && typeof value === "object")
    for (const child of Object.values(value)) finiteControl(child, depth + 1);
}

/** Validate the bounded control envelope; the kernel validates DSP parameters. */
export function parseOperationChain(text: string): OperationChain {
  if (new TextEncoder().encode(text).byteLength > MAX_CHAIN_BYTES)
    throw new Error("Chain exceeds the 1 MiB limit.");
  const chain: unknown = JSON.parse(text);
  finiteControl(chain);
  if (!object(chain)) throw new Error("Chain must be an object.");
  keys(chain, ["version", "operations"]);
  if (
    chain.version !== 1 ||
    !Array.isArray(chain.operations) ||
    chain.operations.length > MAX_CHAIN_OPERATIONS
  )
    throw new Error("Use a version 1 chain with at most 64 operations.");
  for (const op of chain.operations) {
    if (!object(op)) throw new Error("Operation must be an object.");
    keys(op, ["method", "params", "range"]);
    if (typeof op.method !== "string" || !Object.hasOwn(fields, op.method) || !object(op.params))
      throw new Error(
        "Use edit.apply, process.start, effects.apply or speech.generate with object params.",
      );
    keys(op.params, fields[op.method as keyof typeof fields]);
    if (op.range !== undefined && op.range !== "document")
      throw new Error("Range must be omitted or document.");
    if (op.range === "document" && ("start" in op.params || "end" in op.params))
      throw new Error("Document range cannot include start or end.");
    for (const field of common) {
      const value = op.params[field];
      if (
        value !== undefined &&
        (!Number.isSafeInteger(value) || Number(value) < (field === "channelMask" ? 1 : 0))
      )
        throw new Error(`Invalid ${field}.`);
    }
    if (op.method === CHAIN_SPEECH_GENERATE) validateSpeech(op.params);
    else if (op.method !== "effects.apply" && typeof op.params.operation !== "string")
      throw new Error("Operation name is required.");
    if (op.method === "process.start" && op.params.generator === "audio")
      throw new Error("The audio generator needs samples; record speech as speech.generate.");
    if (
      op.method === "process.start" &&
      ["extract-channel", "noise-reduce"].includes(String(op.params.operation))
    )
      throw new Error(
        "Channel extraction and document-bound noise profiles cannot be replayed as editor macros.",
      );
    if (op.method === "effects.apply") {
      if (!object(op.params.graph) || !Array.isArray(op.params.graph.nodes))
        throw new Error("Effect graph is required.");
      if (
        op.params.graph.nodes.some((node: unknown) => object(node) && node.type === "reverb-conv")
      )
        throw new Error("Macros cannot retain loaded convolution impulse responses.");
      if (op.params.previewId !== undefined)
        throw new Error("Omit the session-specific previewId.");
    }
  }
  return chain as unknown as OperationChain;
}

/** Pretty-print when it still fits the import cap; otherwise preserve compact JSON. */
export function serializeOperationChain(chain: OperationChain): string {
  const compact = JSON.stringify(chain);
  parseOperationChain(compact);
  const pretty = `${JSON.stringify(chain, null, 2)}\n`;
  return new TextEncoder().encode(pretty).byteLength <= MAX_CHAIN_BYTES ? pretty : compact;
}

/** Record the successful request, never a preview or a computed audio result. */
export function recordOperation(
  request: AppliedOperation,
  info: DocumentInfoResult,
): RecordedOperation {
  const params: Record<string, unknown> = { ...structuredClone(request.params) };
  delete params.documentId;
  delete params.clipboardVersion;
  delete params.previewId;
  const whole = params.start === 0 && params.end === info.frames && !params.spectralMask;
  if (whole) {
    delete params.start;
    delete params.end;
    if (params.channelMask === 2 ** info.channels - 1) delete params.channelMask;
  }
  const chain = parseOperationChain(
    JSON.stringify({
      version: 1,
      operations: [{ method: request.method, params, ...(whole ? { range: "document" } : {}) }],
    }),
  );
  return chain.operations[0];
}
