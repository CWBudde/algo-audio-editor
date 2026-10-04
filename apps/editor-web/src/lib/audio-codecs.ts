import type { DocumentInfoResult } from "@aae/protocol";
import type { KernelClient } from "@/kernel/client";

export const AUDIO_ACCEPT = ".wav,.flac,.aif,.aiff,.aifc,.mp3,.ogg,.opus,.m4a,.aac,audio/*";
export const AUDIO_TYPES = [
  {
    description: "Audio files",
    accept: {
      "audio/wav": [".wav"],
      "audio/flac": [".flac"],
      "audio/aiff": [".aif", ".aiff", ".aifc"],
      "audio/mpeg": [".mp3"],
      "audio/ogg": [".ogg", ".opus"],
      "audio/mp4": [".m4a"],
      "audio/aac": [".aac"],
    },
  },
];

/** Sniff only the routing header. The Go codecs validate complete containers. */
export function usesKernelCodec(data: ArrayBuffer): boolean {
  const b = new Uint8Array(data);
  const text = (start: number, count: number) =>
    String.fromCharCode(...b.subarray(start, start + count));
  let offset = 0;
  if (text(0, 3) === "ID3") {
    if (b.length < 10 || b[3] < 2 || b[3] > 4 || b.subarray(6, 10).some((v) => v & 128))
      return true;
    offset = 10 + ((b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9]);
    if (b[3] === 4 && b[5] & 16) offset += 10;
    if (offset >= b.length) return true;
  }
  return (
    text(offset, 4) === "fLaC" ||
    text(offset, 4) === "RIFF" ||
    text(offset, 4) === "FORM" ||
    (b[offset] === 255 && (b[offset + 1] & 0xe0) === 0xe0 && ((b[offset + 1] >> 1) & 3) === 1)
  );
}

/** Browser codec glue only: preserve the encoded sample rate and copy planar PCM.
 * Browser support for Ogg/Opus and AAC/M4A varies; failures keep the old document.
 */
export async function openAudioDocument(
  client: KernelClient,
  name: string,
  data: ArrayBuffer,
  active: () => boolean,
): Promise<DocumentInfoResult | undefined> {
  if (usesKernelCodec(data)) return client.openDocument(name, data);
  const rate = encodedSampleRate(data);
  if (!rate || rate < 8000 || rate > 192000)
    throw new Error("Could not determine a supported original sample rate for this container.");
  let decoded: AudioBuffer;
  try {
    decoded = await new OfflineAudioContext(1, 1, rate).decodeAudioData(data);
  } catch {
    throw new Error("This audio format is unsupported or damaged. Browser codec support varies.");
  }
  if (!active()) return;
  if (
    decoded.numberOfChannels < 1 ||
    decoded.numberOfChannels > 8 ||
    decoded.length * decoded.numberOfChannels * 4 > 512 * 1024 * 1024
  )
    throw new Error("Decoded audio exceeds the import memory limit.");
  const pcm = new Float32Array(decoded.length * decoded.numberOfChannels);
  for (let channel = 0; channel < decoded.numberOfChannels; channel++)
    pcm.set(decoded.getChannelData(channel), channel * decoded.length);
  return client.openPCMDocument(
    {
      name,
      sampleRate: decoded.sampleRate,
      channels: decoded.numberOfChannels,
      frames: decoded.length,
      nextAnchorId: 1,
      tags: {},
      markers: [],
      regions: [],
    },
    pcm.buffer,
  );
}

// Container headers provide original rates; this never computes audio samples.
export function encodedSampleRate(data: ArrayBuffer): number | undefined {
  const b = new Uint8Array(data);
  const view = new DataView(data);
  // Read the first complete identification packet from an Ogg BOS page.
  if (
    b.length >= 28 &&
    String.fromCharCode(...b.subarray(0, 4)) === "OggS" &&
    b[4] === 0 &&
    b[5] & 2
  ) {
    const segments = b[26],
      start = 27 + segments;
    let length = 0;
    for (let i = 0; i < segments && 27 + i < b.length; i++) {
      length += b[27 + i];
      if (b[27 + i] < 255) {
        if (start + length > b.length) return;
        const tag = String.fromCharCode(...b.subarray(start, start + 8));
        if (length >= 19 && tag === "OpusHead") return 48000;
        if (
          length >= 30 &&
          b[start] === 1 &&
          String.fromCharCode(...b.subarray(start + 1, start + 7)) === "vorbis"
        )
          return view.getUint32(start + 12, true);
        return;
      }
    }
    return;
  }
  if (b.length >= 7 && b[0] === 255 && (b[1] & 0xf6) === 0xf0)
    return [
      96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
    ][(b[2] >> 2) & 15];
  // ISO BMFF: only inspect audio sample entries inside validated stsd boxes.
  const walk = (start: number, end: number, depth: number): number | undefined => {
    if (depth > 8) return;
    for (let pos = start; pos + 8 <= end; ) {
      const size = view.getUint32(pos),
        tag = String.fromCharCode(...b.subarray(pos + 4, pos + 8));
      if (size < 8 || size > end - pos) return;
      if (["moov", "trak", "mdia", "minf", "stbl"].includes(tag)) {
        const rate = walk(pos + 8, pos + size, depth + 1);
        if (rate) return rate;
      }
      if (tag === "stsd" && size >= 16) {
        let entry = pos + 16;
        for (let n = 0; n < view.getUint32(pos + 12) && entry + 36 <= pos + size; n++) {
          const length = view.getUint32(entry),
            type = String.fromCharCode(...b.subarray(entry + 4, entry + 8));
          if (length < 36 || length > pos + size - entry) return;
          if (type === "mp4a") {
            const version = view.getUint16(entry + 16);
            if (version > 1) return;
            for (let child = entry + (version === 1 ? 52 : 36); child + 8 <= entry + length; ) {
              const size = view.getUint32(child);
              if (size < 8 || size > entry + length - child) return;
              if (String.fromCharCode(...b.subarray(child + 4, child + 8)) === "esds")
                return aacDescriptorRate(b.subarray(child + 12, child + size));
              child += size;
            }
            return view.getUint32(entry + 32) / 65536;
          }
          if (type === "alac") return view.getUint32(entry + 32) / 65536;
          entry += length;
        }
      }
      pos += size;
    }
  };
  return walk(0, b.length, 0);
}

// MPEG-4 DecoderSpecificInfo carries AAC's actual rate; the sample-entry's
// 16.16 field cannot represent rates above 65535 Hz without overflow.
function aacDescriptorRate(bytes: Uint8Array): number | undefined {
  const rates = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
  ];
  const configRate = (data: Uint8Array) => {
    let bit = 0;
    const read = (count: number): number | undefined => {
      if (bit + count > data.length * 8) return;
      let value = 0;
      for (let n = 0; n < count; n++, bit++)
        value = (value << 1) | ((data[bit >> 3] >> (7 - (bit & 7))) & 1);
      return value;
    };
    let object = read(5);
    if (object === 31) {
      const ext = read(6);
      if (ext === undefined) return;
      object = 32 + ext;
    }
    const frequency = () => {
      const index = read(4);
      return index === 15 ? read(24) : index === undefined ? undefined : rates[index];
    };
    let rate = frequency();
    if (read(4) === undefined) return;
    if (object === 5 || object === 29) rate = frequency();
    return rate;
  };
  const walk = (start: number, end: number, depth: number): number | undefined => {
    if (depth > 4) return;
    for (let pos = start; pos < end; ) {
      const tag = bytes[pos++];
      let length = 0,
        complete = false;
      for (let n = 0; n < 4 && pos < end; n++) {
        const value = bytes[pos++];
        length = (length << 7) | (value & 127);
        if (!(value & 128)) {
          complete = true;
          break;
        }
      }
      if (!complete || length > end - pos) return;
      const limit = pos + length;
      if (tag === 5) return configRate(bytes.subarray(pos, limit));
      if (tag === 3) {
        if (length < 3) return;
        const flags = bytes[pos + 2];
        let child = pos + 3;
        if (flags & 128) child += 2;
        if (flags & 64) {
          if (child >= limit) return;
          child += 1 + bytes[child];
        }
        if (flags & 32) child += 2;
        if (child > limit) return;
        const rate = walk(child, limit, depth + 1);
        if (rate) return rate;
      } else if (tag === 4 && length >= 13) {
        const rate = walk(pos + 13, limit, depth + 1);
        if (rate) return rate;
      }
      pos = limit;
    }
  };
  return walk(0, bytes.length, 0);
}
