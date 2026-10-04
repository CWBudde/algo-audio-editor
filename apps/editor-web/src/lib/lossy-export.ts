import type { DocumentInfoResult, ExportResult, SelectionRange } from "@aae/protocol";
import type { KernelClient } from "@/kernel/client";
import { exportName, type LossyFormat } from "./export-settings";
import { MAX_LOSSY_BYTES, OggOpusMuxer } from "./ogg-opus";

export interface EncoderSupport {
  opus: boolean;
  m4a: boolean;
}
export const LOSSY_BITRATES = [64, 96, 128, 192, 256] as const;
const CODEC_TIMEOUT = 30_000;

export function lossyConfig(
  format: LossyFormat,
  sampleRate: number,
  channels: number,
  bitrate: number,
): AudioEncoderConfig {
  return {
    codec: format === "opus" ? "opus" : "mp4a.40.2",
    sampleRate,
    numberOfChannels: channels,
    bitrate: bitrate * 1000,
    ...(format === "opus"
      ? { opus: { format: "opus" as const, frameDuration: 20000 } }
      : { aac: { format: "aac" as const } }),
  };
}

export function exportGeometry(
  info: DocumentInfoResult,
  selection: SelectionRange,
  scope: "document" | "selection",
) {
  const start = scope === "selection" ? selection.start : 0;
  const end = scope === "selection" ? selection.end : info.frames;
  const mask = scope === "selection" ? selection.channelMask : 2 ** info.channels - 1;
  const channels = Array.from({ length: info.channels }, (_, channel) => channel).filter(
    (channel) => mask & (1 << channel),
  ).length;
  return { start, end, mask, channels };
}

/** Feature detection includes the exact rate/channel/bitrate configuration. */
export async function encoderSupport(
  sampleRate: number,
  channels: number,
  bitrate: number,
  signal?: AbortSignal,
): Promise<EncoderSupport> {
  const result: EncoderSupport = { opus: false, m4a: false };
  if (
    typeof AudioEncoder === "undefined" ||
    typeof AudioData === "undefined" ||
    channels < 1 ||
    channels > 2
  )
    return result;
  await Promise.all(
    (["opus", "m4a"] as const).map(async (format) => {
      // Chromium raw-Opus headers use native-rate lookahead below 48 kHz,
      // whereas Ogg pre-skip must use the 48 kHz clock. Keep this path at 48 kHz
      // until encoders supply a portable header; users can resample in Go.
      if (format === "opus" && sampleRate !== 48000) return;
      // A silent/stuck platform probe must not leave the dialog checking forever.
      try {
        const support = await waitCodec(
          AudioEncoder.isConfigSupported(lossyConfig(format, sampleRate, channels, bitrate)),
          signal,
        );
        result[format] = support.supported === true;
      } catch {
        /* An unavailable platform codec is an unsupported choice. */
      }
    }),
  );
  return result;
}

function waitCodec<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const fail = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const abort = () => fail(new DOMException("Export cancelled", "AbortError"));
    const timer = setTimeout(
      () => fail(new Error("The audio encoder stopped responding.")),
      CODEC_TIMEOUT,
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    promise.then((value) => {
      cleanup();
      resolve(value);
    }, fail);
  });
}

/** WebCodecs is the only encoder; JS transfers PCM and frames encoded packets. */
export async function exportLossy(
  client: KernelClient,
  info: DocumentInfoResult,
  selection: SelectionRange,
  scope: "document" | "selection",
  format: LossyFormat,
  bitrate: number,
  signal: AbortSignal,
): Promise<ExportResult> {
  const check = () => signal.throwIfAborted();
  const { start, end, mask, channels } = exportGeometry(info, selection, scope);
  if (
    end <= start ||
    channels < 1 ||
    channels > 2 ||
    !LOSSY_BITRATES.includes(bitrate as (typeof LOSSY_BITRATES)[number])
  )
    throw new Error("Lossy export requires nonempty mono/stereo audio and a valid bitrate.");
  check();
  if (!(await encoderSupport(info.sampleRate, channels, bitrate, signal))[format])
    throw new Error(
      "This browser cannot encode the selected format at this sample rate and channel count.",
    );
  check();
  const history = await client.call("history.list", { documentId: info.documentId });
  check();
  const ogg =
    format === "opus"
      ? new OggOpusMuxer(channels, crypto.getRandomValues(new Uint32Array(1))[0])
      : undefined;
  const mp4 = format === "m4a" ? await waitCodec(import("mp4-muxer"), signal) : undefined;
  check();
  const target = mp4 ? new mp4.ArrayBufferTarget() : undefined;
  const muxer =
    mp4 && target
      ? new mp4.Muxer({
          target,
          audio: { codec: "aac", sampleRate: info.sampleRate, numberOfChannels: channels },
          fastStart: "in-memory",
          firstTimestampBehavior: "offset",
        })
      : undefined;
  let encodedBytes = 0;
  let failed: Error | undefined;
  let packets = 0;
  // Output callbacks must contain their exceptions; otherwise platform callbacks
  // report uncaught errors and leave export waiting for a successful flush.
  const encoder = new AudioEncoder({
    error: (error) => {
      failed = error;
    },
    output: (chunk, metadata) => {
      if (failed || signal.aborted) return;
      try {
        encodedBytes += chunk.byteLength + 512;
        if (encodedBytes > MAX_LOSSY_BYTES - 1024 * 1024)
          throw new Error("Lossy export exceeds the 128 MiB limit.");
        if (ogg) {
          const packet = new Uint8Array(chunk.byteLength);
          chunk.copyTo(packet);
          const description = metadata?.decoderConfig?.description;
          const bytes = description
            ? ArrayBuffer.isView(description)
              ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
              : new Uint8Array(description)
            : undefined;
          ogg.add(packet, chunk.duration ?? 0, bytes);
        } else muxer?.addAudioChunk(chunk, metadata);
        packets++;
      } catch (error) {
        failed = error instanceof Error ? error : new Error(String(error));
      }
    },
  });
  const abort = () => {
    if (encoder.state !== "closed") encoder.close();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    check();
    encoder.configure(lossyConfig(format, info.sampleRate, channels, bitrate));
    for (let offset = start; offset < end; ) {
      check();
      if (failed) throw failed;
      const frames = Math.min(8192, end - offset);
      const pcm = await client.call("doc.readPCM", {
        documentId: info.documentId,
        stateId: history.currentStateId,
        start: offset,
        frames,
        channelMask: mask,
      });
      check();
      if (
        pcm.frames !== frames ||
        pcm.channels !== channels ||
        pcm.sampleRate !== info.sampleRate ||
        pcm.data.byteLength !== frames * channels * 4
      )
        throw new Error("The kernel returned an invalid PCM page.");
      const audio = new AudioData({
        format: "f32-planar",
        sampleRate: info.sampleRate,
        numberOfChannels: channels,
        numberOfFrames: frames,
        timestamp: Math.round(((offset - start) * 1_000_000) / info.sampleRate),
        data: pcm.data,
        transfer: [pcm.data],
      });
      try {
        encoder.encode(audio);
      } finally {
        audio.close();
      }
      offset += frames;
      // Bound queued PCM and yield to native callbacks without flush-padding
      // intermediate pages. Polling also observes errors that don't dequeue.
      const deadline = Date.now() + CODEC_TIMEOUT;
      while (encoder.encodeQueueSize >= 8) {
        await waitCodec(new Promise<void>((resolve) => setTimeout(resolve, 0)), signal);
        check();
        if (failed) throw failed;
        if (Date.now() >= deadline) throw new Error("The audio encoder stopped responding.");
      }
    }
    await waitCodec(encoder.flush(), signal);
    check();
    if (failed) throw failed;
    if (!packets) throw new Error("The audio encoder returned no packets.");
    // Recheck after encoding: out-of-band edits must never write mixed output.
    const current = await client.call("history.list", { documentId: info.documentId });
    check();
    if (current.currentStateId !== history.currentStateId)
      throw new Error("The document changed during export.");
    muxer?.finalize();
    const data = ogg ? ogg.finish(end - start, info.sampleRate) : target?.buffer;
    if (!data || data.byteLength > MAX_LOSSY_BYTES)
      throw new Error("Lossy export exceeds the 128 MiB limit.");
    return {
      name: exportName(info.name, format, scope === "selection"),
      mimeType: format === "opus" ? "audio/ogg" : "audio/mp4",
      dataBytes: data.byteLength,
      data,
    };
  } finally {
    signal.removeEventListener("abort", abort);
    if (encoder.state !== "closed") encoder.close();
  }
}
