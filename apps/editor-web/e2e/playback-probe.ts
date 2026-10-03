import type { Page } from "@playwright/test";

declare global {
  interface Window {
    __aaePlaybackProbe?: {
      context: AudioContext;
      analysers: AnalyserNode[];
      ring: { sab: SharedArrayBuffer; capacityFrames: number };
    };
  }
}

/** Tap the real production node only in tests, with no application debug API. */
export async function capturePlayback(page: Page) {
  await page.addInitScript(() => {
    const NativeContext = window.AudioContext;
    window.AudioContext = class extends NativeContext {
      constructor(options?: AudioContextOptions) {
        super({ ...options, sampleRate: 48000 });
      }
    };
    const NativeNode = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends NativeNode {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        if (name !== "aae-playback") return;
        const splitter = context.createChannelSplitter(options?.outputChannelCount?.[0] ?? 2);
        this.connect(splitter);
        const mute = context.createGain();
        mute.gain.value = 0;
        mute.connect(context.destination);
        const analysers = Array.from(
          { length: options?.outputChannelCount?.[0] ?? 2 },
          (_, channel) => {
            const analyser = context.createAnalyser();
            analyser.fftSize = 256;
            splitter.connect(analyser, channel);
            analyser.connect(mute);
            return analyser;
          },
        );
        window.__aaePlaybackProbe = {
          context: context as AudioContext,
          analysers,
          ring: options?.processorOptions.ring,
        };
      }
    };
  });
}
