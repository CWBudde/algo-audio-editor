/// <reference lib="dom" />
import type { Page } from "@playwright/test";

declare global {
  interface Window {
    __aaeEffectTiming?: {
      ready: Promise<void>;
      control: Int32Array;
      frame: Float64Array;
      updates: { requestAt: number; ackAt?: number }[];
      horizons: number[];
    };
  }
}

// Test-only tap of the production output. The sample clock is recorded on the
// audio thread, so a delayed main-thread poll cannot inflate or hide latency.
const timingWorklet = `
class EffectTimingTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.control = new Int32Array(options.processorOptions.sab, 0, 2);
    this.frame = new Float64Array(options.processorOptions.sab, 16, 1);
    this.signs = new Int8Array(64);
    this.position = 0;
    this.count = 0;
    this.crossings = 0;
    this.armed = false;
  }
  process(inputs) {
    const state = Atomics.load(this.control, 0);
    if (state !== 1) { this.armed = false; return true; }
    if (!this.armed) {
      this.signs.fill(0); this.position = 0; this.count = 0;
      this.crossings = 0; this.armed = true;
    }
    const samples = inputs[0]?.[0];
    if (!samples) return true;
    const mode = Atomics.load(this.control, 1);
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      const sign = sample > 0 ? 1 : -1;
      const previous = this.signs[(this.position + 63) & 63];
      if (this.count >= 64) {
        const next = this.signs[(this.position + 1) & 63];
        if (this.signs[this.position] !== next) this.crossings--;
      }
      if (this.count > 0 && previous !== sign) this.crossings++;
      this.signs[this.position] = sign;
      this.position = (this.position + 1) & 63;
      this.count++;
      if ((mode === 1 && sample > 0.2) || (mode === 3 && sample > 0.35) ||
          (mode === 2 && this.count >= 64 && this.crossings >= 4 && Math.abs(sample) > 0.05)) {
        this.frame[0] = currentFrame + i;
        Atomics.store(this.control, 0, 2);
        break;
      }
    }
    return true;
  }
}
registerProcessor("aae-effect-timing", EffectTimingTap);
`;

export async function captureEffectTiming(page: Page) {
  await page.addInitScript((source) => {
    const sab = new SharedArrayBuffer(32);
    const control = new Int32Array(sab, 0, 2);
    const frame = new Float64Array(sab, 16, 1);
    frame[0] = -1;
    const updates: { requestAt: number; ackAt?: number }[] = [];
    const horizons: number[] = [];
    const diagnostics = { ready: Promise.resolve(), control, frame, updates, horizons };
    window.__aaeEffectTiming = diagnostics;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      override postMessage(
        message: unknown,
        transfer?: Transferable[] | StructuredSerializeOptions,
      ) {
        const request = message as {
          id: number;
          op: string;
          method?: string;
          maxBufferedFrames?: number;
        };
        if (request.method === "effects.preview.update") {
          const timing = { requestAt: performance.now() } as { requestAt: number; ackAt?: number };
          updates.push(timing);
          const reply = (event: MessageEvent) => {
            if (event.data.kind !== "reply" || event.data.id !== request.id) return;
            this.removeEventListener("message", reply);
            timing.ackAt = performance.now();
          };
          this.addEventListener("message", reply);
        }
        if (request.op === "stream.start") horizons.push(request.maxBufferedFrames ?? 8191);
        if (Array.isArray(transfer)) super.postMessage(message, transfer);
        else super.postMessage(message, transfer);
      }
    };
    const NativeNode = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends NativeNode {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        if (name !== "aae-playback") return;
        const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
        diagnostics.ready = context.audioWorklet
          .addModule(url)
          .finally(() => URL.revokeObjectURL(url))
          .then(() => {
            const tap = new NativeNode(context, "aae-effect-timing", {
              numberOfInputs: 1,
              numberOfOutputs: 1,
              outputChannelCount: [1],
              channelCount: 1,
              channelCountMode: "explicit",
              processorOptions: { sab },
            });
            this.connect(tap);
            const mute = context.createGain();
            mute.gain.value = 0;
            tap.connect(mute);
            mute.connect(context.destination);
          });
      }
    };
  }, timingWorklet);
}
