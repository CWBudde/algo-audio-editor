import { expect, it } from "vitest";
import {
  createMeterBuffer,
  METERS_DATA_BYTES,
  METERS_HEADER_BYTES,
  MeterPublisher,
  MeterReader,
} from "./meter-data";

function publish(buffer: SharedArrayBuffer, channels = 2) {
  new MeterPublisher(buffer).publish((bytes) => {
    const data = new Float64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 8);
    data.set([1, channels, 128, 48000, -18, -19, -20, 3, 0.75, 2]);
    data.set([0.5, 0.25, 0.75, 0.6, 0.4, 0.2, 0.7, 0.55], 16);
    data.set([-17, -18, 1, 48000 * 60, 0, 15], 10);
    data.set([0.1, 0.2, -0.1, -0.2], 64);
    return METERS_DATA_BYTES;
  });
}
it("copies a complete versioned kernel snapshot and owns its vectorscope data", () => {
  const buffer = createMeterBuffer();
  const reader = new MeterReader(buffer);
  expect(reader.read()).toBeUndefined();
  publish(buffer);
  const snapshot = reader.read();
  expect(snapshot).toMatchObject({
    frames: 128,
    sampleRate: 48000,
    momentary: -18,
    integrated: -20,
    correlation: 0.75,
    maximumMomentary: -17,
    maximumShortTerm: -18,
    rangeStable: true,
    loudnessFrames: 48000 * 60,
    failure: 0,
    availability: 15,
    channels: [
      { peak: 0.5, rms: 0.25, hold: 0.75, truePeak: 0.6 },
      { peak: 0.4, rms: 0.2, hold: 0.7, truePeak: 0.55 },
    ],
  });
  expect(Array.from(snapshot?.goniometer ?? [])).toEqual([0.1, 0.2, -0.1, -0.2]);
  new Float64Array(buffer, METERS_HEADER_BYTES).fill(0);
  expect(Array.from(snapshot?.goniometer ?? [])).toEqual([0.1, 0.2, -0.1, -0.2]);
});
it("never reads a snapshot while its writer is fenced, including wraparound", () => {
  const buffer = createMeterBuffer();
  publish(buffer);
  const header = new Int32Array(buffer, 0, METERS_HEADER_BYTES / 4);
  Atomics.store(header, 0, 0x7fffffff);
  expect(new MeterReader(buffer).read()).toBeUndefined();
  Atomics.add(header, 0, 1);
  expect(new MeterReader(buffer).read()?.frames).toBe(128);
});
it("publishes disabled state and releases its sequence lock after failed copies", () => {
  const buffer = createMeterBuffer();
  const publisher = new MeterPublisher(buffer);
  publish(buffer);
  publisher.publish(() => 0);
  expect(new MeterReader(buffer).read()).toBeUndefined();
  expect(() =>
    publisher.publish(() => {
      throw new Error("bridge failed");
    }),
  ).toThrow("bridge failed");
  expect(Atomics.load(new Int32Array(buffer), 0) & 1).toBe(0);
});
it("rejects invalid snapshot geometry and a mismatched buffer", () => {
  expect(() => new MeterReader(new SharedArrayBuffer(16))).toThrow("Invalid meter buffer size");
  const buffer = createMeterBuffer();
  publish(buffer, 9);
  expect(new MeterReader(buffer).read()).toBeUndefined();
});

it.each([
  [8, NaN],
  [16, -0.1],
  [19, Infinity],
  [3, 400000],
  [12, 2],
  [13, -1],
  [14, 4],
  [15, 16],
])("rejects invalid presentation metadata at slot %i", (slot, value) => {
  const buffer = createMeterBuffer();
  publish(buffer);
  new Float64Array(buffer, METERS_HEADER_BYTES)[slot] = value;
  expect(new MeterReader(buffer).read()).toBeUndefined();
});
