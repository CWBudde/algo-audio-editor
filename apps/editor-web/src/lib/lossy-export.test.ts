import type { DocumentInfoResult } from "@aae/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { KernelClient } from "@/kernel/client";
import { exportFileTypes, exportName, updateExportSettings } from "./export-settings";
import { encoderSupport, exportLossy } from "./lossy-export";
import { MAX_LOSSY_BYTES } from "./ogg-opus";

function opusHead(channels = 2, skip = 312) {
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode("OpusHead"));
  head[8] = 1;
  head[9] = channels;
  const view = new DataView(head.buffer);
  view.setUint16(10, skip, true);
  view.setUint32(12, 48000, true);
  return head;
}

const info: DocumentInfoResult = {
  documentId: "doc-1",
  name: "tone.wav",
  sampleRate: 48000,
  channels: 2,
  frames: 17000,
  bitDepth: 32,
  float: true,
};
const range = { start: 100, end: 16999, channelMask: 2 };
let mode = "ok",
  close = vi.fn(),
  audioClose = vi.fn();
let inputs: AudioDataInit[] = [];
class FakeData {
  init: AudioDataInit;
  constructor(init: AudioDataInit) {
    this.init = init;
    inputs.push(init);
  }
  close = audioClose;
}
class FakeEncoder {
  static isConfigSupported = vi.fn(async (config: AudioEncoderConfig) => ({
    supported: config.codec === "opus",
    config,
  }));
  init: AudioEncoderInit;
  config?: AudioEncoderConfig;
  state = "unconfigured";
  encodeQueueSize = 0;
  frames = 0;
  constructor(init: AudioEncoderInit) {
    this.init = init;
  }
  configure(config: AudioEncoderConfig) {
    this.config = config;
    this.state = "configured";
  }
  encode(data: FakeData) {
    this.frames += data.init.numberOfFrames;
    if (mode === "queue") this.encodeQueueSize = 8;
  }
  async flush() {
    if (mode === "stall") return new Promise<void>(() => {});
    if (mode === "error") {
      this.init.error(new DOMException("encoder failed"));
      return;
    }
    const count = Math.ceil((this.frames + 312) / 960);
    for (let i = 0; i < count; i++) {
      this.init.output(
        {
          byteLength: mode === "large" ? MAX_LOSSY_BYTES : 3,
          duration: 20000,
          copyTo: (data: Uint8Array) => data.set([0xf8, 0xff, 0xfe]),
        } as unknown as EncodedAudioChunk,
        i === 0
          ? {
              decoderConfig: {
                codec: "opus",
                sampleRate: 48000,
                numberOfChannels: this.config?.numberOfChannels ?? 2,
                description:
                  mode === "header" ? undefined : opusHead(this.config?.numberOfChannels),
              },
            }
          : {},
      );
    }
  }
  close() {
    this.state = "closed";
    close();
  }
}
function client() {
  const call = vi.fn(
    async (method: string, params: { frames: number; channelMask: number }): Promise<unknown> =>
      method === "history.list"
        ? { currentStateId: "state-1" }
        : {
            sampleRate: 48000,
            channels: params.channelMask === 2 ? 1 : 2,
            frames: params.frames,
            dataBytes: params.frames * (params.channelMask === 2 ? 1 : 2) * 4,
            data: new ArrayBuffer(params.frames * (params.channelMask === 2 ? 1 : 2) * 4),
          },
  );
  return { call, value: { call } as unknown as KernelClient };
}
beforeEach(() => {
  mode = "ok";
  inputs = [];
  close = vi.fn();
  audioClose = vi.fn();
  FakeEncoder.isConfigSupported.mockClear();
  vi.stubGlobal("AudioData", FakeData);
  vi.stubGlobal("AudioEncoder", FakeEncoder);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("detects codec APIs, native rates and mono/stereo configurations", async () => {
  expect(await encoderSupport(48000, 2, 128)).toEqual({ opus: true, m4a: false });
  expect(FakeEncoder.isConfigSupported).toHaveBeenCalledWith(
    expect.objectContaining({
      codec: "opus",
      bitrate: 128000,
      numberOfChannels: 2,
      opus: { format: "opus", frameDuration: 20000 },
    }),
  );
  expect(await encoderSupport(44100, 2, 128)).toEqual({ opus: false, m4a: false });
  FakeEncoder.isConfigSupported.mockClear();
  expect(await encoderSupport(48000, 6, 128)).toEqual({ opus: false, m4a: false });
  expect(FakeEncoder.isConfigSupported).not.toHaveBeenCalled();
  vi.stubGlobal("AudioEncoder", undefined);
  expect(await encoderSupport(48000, 2, 128)).toEqual({ opus: false, m4a: false });
});
it("copies only bounded selected-channel pages, timestamps from zero and closes native resources", async () => {
  const c = client();
  const result = await exportLossy(
    c.value,
    info,
    range,
    "selection",
    "opus",
    128,
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    name: "tone-selection.opus",
    mimeType: "audio/ogg",
    dataBytes: result.data.byteLength,
  });
  const pages = c.call.mock.calls.filter(([method]) => method === "doc.readPCM").map(([, p]) => p);
  expect(pages).toEqual(
    [8192, 8192, 515].map((frames, i) => ({
      documentId: "doc-1",
      stateId: "state-1",
      start: 100 + i * 8192,
      frames,
      channelMask: 2,
    })),
  );
  expect(inputs.map((p) => p.timestamp)).toEqual([0, 170667, 341333]);
  expect(
    inputs.every(
      (p) => p.numberOfChannels === 1 && p.format === "f32-planar" && p.transfer?.[0] === p.data,
    ),
  ).toBe(true);
  expect(audioClose).toHaveBeenCalledTimes(3);
  expect(close).toHaveBeenCalledOnce();
  expect(c.call.mock.calls.some(([m]) => m === "doc.markSaved")).toBe(false);
});
it.each(["error", "header", "large"])(
  "fails %s without writing output and releases the encoder",
  async (failure) => {
    mode = failure;
    await expect(
      exportLossy(
        client().value,
        info,
        range,
        "document",
        "opus",
        128,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(close).toHaveBeenCalledOnce();
  },
);
it("rejects a history change after encoding and malformed PCM replies", async () => {
  const c = client();
  let history = 0;
  c.call.mockImplementation(
    async (method: string, params: { frames: number; channelMask: number }) => {
      if (method === "history.list")
        return { currentStateId: ++history === 1 ? "state-1" : "state-2" };
      return {
        sampleRate: 48000,
        channels: 2,
        frames: params.frames,
        dataBytes: params.frames * 8,
        data: new ArrayBuffer(params.frames * 8),
      };
    },
  );
  await expect(
    exportLossy(c.value, info, range, "document", "opus", 128, new AbortController().signal),
  ).rejects.toThrow(/document changed/);
  c.call.mockImplementation(async (method: string) =>
    method === "history.list" ? { currentStateId: "state-1" } : { frames: 0 },
  );
  await expect(
    exportLossy(c.value, info, range, "document", "opus", 128, new AbortController().signal),
  ).rejects.toThrow(/invalid PCM/);
});
it("aborts a stalled native flush promptly and times out a stuck queue", async () => {
  vi.useFakeTimers();
  mode = "stall";
  const controller = new AbortController();
  const promise = exportLossy(
    client().value,
    info,
    range,
    "document",
    "opus",
    128,
    controller.signal,
  );
  const rejected = expect(promise).rejects.toThrow(/cancelled/);
  await vi.advanceTimersByTimeAsync(10);
  controller.abort();
  await rejected;
  expect(close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  mode = "queue";
  const queued = exportLossy(
    client().value,
    info,
    range,
    "document",
    "opus",
    128,
    new AbortController().signal,
  );
  const timed = expect(queued).rejects.toThrow(/stopped responding/);
  await vi.advanceTimersByTimeAsync(30002);
  await timed;
  expect(vi.getTimerCount()).toBe(0);
});
it("names compressed copies and clears integer quantization controls", () => {
  expect(exportName("a.FLAC", "m4a", true)).toBe("a-selection.m4a");
  expect(exportFileTypes("opus")).toEqual([
    { description: "OPUS audio", accept: { "audio/ogg": [".opus"] } },
  ]);
  expect(
    updateExportSettings(
      {
        encoding: "pcm",
        bitDepth: 16,
        scope: "document",
        dither: "triangular",
        noiseShaping: "sharp",
      },
      { format: "opus" },
    ),
  ).toMatchObject({ bitrate: 128, dither: "none", noiseShaping: "none" });
});
