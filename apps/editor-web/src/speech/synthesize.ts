import type { SpeechStage } from "./client";
import type { SpeechSynthesisParams, SpeechSynthesisResult } from "./messages";
import { holdSpeech, startSpeech } from "./runtime";

/**
 * Speaks `params` with the page's speech worker: loads (and if needed
 * downloads) the model and voice, then synthesizes. The worker stays alive
 * while this runs and for the idle period afterwards.
 */
export async function synthesizeSpeech(
  params: SpeechSynthesisParams,
  options: { signal?: AbortSignal; onProgress?(progress: SpeechStage): void } = {},
): Promise<SpeechSynthesisResult> {
  const release = holdSpeech();
  try {
    const client = await startSpeech();
    await client.ensureModel(params.model, params.voice, options.onProgress, options.signal);
    return await client.synthesize(params, options.onProgress, options.signal);
  } finally {
    release();
  }
}
