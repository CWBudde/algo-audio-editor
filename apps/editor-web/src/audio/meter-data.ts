/** Kernel-computed metering travels through this small, worker-owned SAB. */
export const METERS_HEADER_BYTES = 64;

import {
  METERS_CHANNEL_OFFSET,
  METERS_CHANNEL_STRIDE,
  METERS_DATA_BYTES,
  METERS_FLOAT64_COUNT,
  METERS_GONIOMETER_CAPACITY,
  METERS_GONIOMETER_OFFSET,
} from "@aae/protocol";

export {
  METERS_CHANNEL_OFFSET,
  METERS_CHANNEL_STRIDE,
  METERS_DATA_BYTES,
  METERS_FLOAT64_COUNT,
  METERS_GONIOMETER_CAPACITY,
  METERS_GONIOMETER_OFFSET,
};
export const METERS_SHARED_BYTES = METERS_HEADER_BYTES + METERS_DATA_BYTES;

export interface ChannelMeter {
  channel: number;
  peak: number;
  rms: number;
  hold: number;
  truePeak: number;
}
export interface MeterSnapshot {
  frames: number;
  sampleRate: number;
  channels: ChannelMeter[];
  momentary: number;
  shortTerm: number;
  integrated: number;
  range: number;
  correlation: number;
  maximumMomentary: number;
  maximumShortTerm: number;
  loudnessFrames: number;
  rangeStable: boolean;
  failure: number;
  availability: number;
  /** Kernel-computed mid/side coordinates; drawing only, no JS audio analysis. */
  goniometer: Float64Array;
}

export function createMeterBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(METERS_SHARED_BYTES);
}
function views(buffer: SharedArrayBuffer) {
  if (buffer.byteLength !== METERS_SHARED_BYTES) throw new Error("Invalid meter buffer size");
  return {
    header: new Int32Array(buffer, 0, METERS_HEADER_BYTES / 4),
    payload: new Float64Array(buffer, METERS_HEADER_BYTES, METERS_FLOAT64_COUNT),
  };
}

/** The worker is the only writer; both revision increments are atomic. */
export class MeterPublisher {
  private readonly header: Int32Array;
  private readonly bytes: Uint8Array;
  constructor(buffer: SharedArrayBuffer) {
    this.header = views(buffer).header;
    this.bytes = new Uint8Array(buffer, METERS_HEADER_BYTES, METERS_DATA_BYTES);
  }
  publish(copy: (target: Uint8Array) => number): void {
    Atomics.add(this.header, 0, 1);
    Atomics.store(this.header, 1, 0);
    try {
      Atomics.store(this.header, 1, copy(this.bytes) === METERS_DATA_BYTES ? 1 : 0);
    } finally {
      // Readers must never remain fenced forever after a failed bridge copy.
      Atomics.add(this.header, 0, 1);
    }
  }
}

export class MeterReader {
  private readonly header: Int32Array;
  private readonly payload: Float64Array;
  private readonly scratch = new Float64Array(METERS_FLOAT64_COUNT);
  constructor(buffer: SharedArrayBuffer) {
    const shared = views(buffer);
    this.header = shared.header;
    this.payload = shared.payload;
  }
  read(): MeterSnapshot | undefined {
    for (let attempt = 0; attempt < 3; attempt++) {
      const revision = Atomics.load(this.header, 0);
      if (revision & 1) continue;
      if (!Atomics.load(this.header, 1)) return;
      this.scratch.set(this.payload);
      if (Atomics.load(this.header, 0) !== revision) continue;
      const data = this.scratch;
      const channels = data[1];
      const count = data[9];
      if (
        data[0] !== 1 ||
        !Number.isInteger(channels) ||
        channels < 1 ||
        channels > 8 ||
        !Number.isInteger(count) ||
        count < 0 ||
        count > METERS_GONIOMETER_CAPACITY ||
        !Number.isSafeInteger(data[2]) ||
        data[2] < 0 ||
        !Number.isFinite(data[3]) ||
        data[3] < 8000 ||
        data[3] > 384000 ||
        !Number.isFinite(data[8]) ||
        data[8] < -1 ||
        data[8] > 1 ||
        [data[4], data[5], data[6], data[10], data[11]].some(
          (value) => Number.isNaN(value) || value === Infinity,
        ) ||
        !Number.isFinite(data[7]) ||
        data[7] < 0 ||
        ![0, 1].includes(data[12]) ||
        !Number.isSafeInteger(data[13]) ||
        data[13] < 0 ||
        ![0, 1, 2, 3].includes(data[14]) ||
        !Number.isInteger(data[15]) ||
        data[15] < 0 ||
        data[15] > 15
      )
        return;
      const levels: ChannelMeter[] = [];
      for (let channel = 0; channel < channels; channel++) {
        const offset = METERS_CHANNEL_OFFSET + channel * METERS_CHANNEL_STRIDE;
        if (
          data
            .subarray(offset, offset + METERS_CHANNEL_STRIDE)
            .some((value) => !Number.isFinite(value) || value < 0)
        )
          return;
        levels.push({
          channel,
          peak: data[offset],
          rms: data[offset + 1],
          hold: data[offset + 2],
          truePeak: data[offset + 3],
        });
      }
      if (
        data
          .subarray(METERS_GONIOMETER_OFFSET, METERS_GONIOMETER_OFFSET + count * 2)
          .some((value) => !Number.isFinite(value))
      )
        return;
      return {
        frames: data[2],
        sampleRate: data[3],
        channels: levels,
        momentary: data[4],
        shortTerm: data[5],
        integrated: data[6],
        range: data[7],
        correlation: data[8],
        maximumMomentary: data[10],
        maximumShortTerm: data[11],
        rangeStable: data[12] === 1,
        loudnessFrames: data[13],
        failure: data[14],
        availability: data[15],
        goniometer: data.slice(METERS_GONIOMETER_OFFSET, METERS_GONIOMETER_OFFSET + count * 2),
      };
    }
  }
}
