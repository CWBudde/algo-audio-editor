import type { AnalysisStartParams } from "@aae/protocol";
export type SpectralSettings = Required<
  Pick<AnalysisStartParams, "fftSize" | "window" | "averaging" | "smoothing">
>;
export const DEFAULT_SPECTRAL_SETTINGS: SpectralSettings = {
  fftSize: 2048,
  window: "hann",
  averaging: 8,
  smoothing: 0,
};
export const FFT_SIZES = [256, 512, 1024, 2048, 4096, 8192] as const;
export const ANALYSIS_WINDOWS = ["hann", "hamming", "blackman", "rectangular"] as const;
export const ANALYSIS_AVERAGES = [1, 4, 8, 16, 32, 64] as const;
export const ANALYSIS_SMOOTHING = [0, 3, 6, 12, 24] as const;
