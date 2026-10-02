import type { RingBufferInit } from "./ring-buffer";

/**
 * Values shared by the playback worklet and the main thread. Kept apart from
 * playback-worklet.ts because importing that module runs registerProcessor,
 * which only exists inside an AudioWorkletGlobalScope.
 */
export const PLAYBACK_PROCESSOR = "aae-playback";

export interface PlaybackProcessorOptions {
  ring: RingBufferInit;
}
