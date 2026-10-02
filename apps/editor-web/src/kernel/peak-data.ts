import type { PeaksGetResult } from "@aae/protocol";

export interface PeakViews {
  /** Consecutive min/max/RMS triples; every value was computed by the kernel. */
  peaks: Float32Array;
  frameCounts: Uint32Array;
  /** Absolute positions include shortened blocks and preserve cached bucket bounds. */
  startFrames: Float64Array;
}

/** View the packed peak response without copying or processing audio samples. */
export function decodePeaks(result: PeaksGetResult): PeakViews {
  const { count, data, dataBytes, framesPerBucket } = result;
  if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(count * 24)) {
    throw new Error("peaks.get: invalid bucket count");
  }
  if (
    !Number.isSafeInteger(framesPerBucket) ||
    framesPerBucket < 0 ||
    (count > 0 && framesPerBucket === 0)
  ) {
    throw new Error("peaks.get: invalid frames per bucket");
  }
  if (dataBytes !== count * 24 || data.byteLength !== dataBytes) {
    throw new Error("peaks.get: packed data length does not match bucket count");
  }

  const peaks = new Float32Array(data, 0, count * 3);
  const frameCounts = new Uint32Array(data, count * 12, count);
  const startFrames = new Float64Array(data, count * 16, count);
  for (let index = 0; index < count; index++) {
    if (frameCounts[index] === 0 || frameCounts[index] > framesPerBucket) {
      throw new Error("peaks.get: invalid bucket frame count");
    }
    const start = startFrames[index];
    if (
      !Number.isSafeInteger(start) ||
      start < 0 ||
      !Number.isSafeInteger(start + frameCounts[index]) ||
      (index > 0 && start < startFrames[index - 1] + frameCounts[index - 1])
    ) {
      throw new Error("peaks.get: invalid bucket position");
    }
  }
  return { peaks, frameCounts, startFrames };
}
