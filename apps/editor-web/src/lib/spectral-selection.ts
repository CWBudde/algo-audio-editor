import type { SpectralMask, SpectralPoint } from "@aae/protocol";

export interface SpectralSelection {
  documentId: string;
  channelMask: number;
  mask: SpectralMask;
}
export type SpectralTool = "time" | "rectangle" | "lasso";

/** Maps display coordinates only. Sample analysis and editing remain in Go. */
export function spectralPoint(
  x: number,
  y: number,
  width: number,
  height: number,
  viewport: { start: number; end: number },
  frames: number,
  sampleRate: number,
): SpectralPoint {
  return {
    frame: Math.max(
      0,
      Math.min(
        frames,
        viewport.start +
          Math.max(0, Math.min(1, x / Math.max(1, width))) * (viewport.end - viewport.start),
      ),
    ),
    hz: Math.max(
      0,
      Math.min(
        sampleRate / 2,
        ((1 - Math.max(0, Math.min(1, y / Math.max(1, height)))) * sampleRate) / 2,
      ),
    ),
  };
}
export function spectralMask(
  points: SpectralPoint[],
  tool: Exclude<SpectralTool, "time">,
  frames: number,
): SpectralMask | undefined {
  if (points.length < 2 || points.some((p) => !Number.isFinite(p.frame) || !Number.isFinite(p.hz)))
    return;
  const start = Math.max(0, Math.floor(Math.min(...points.map((p) => p.frame)))),
    end = Math.min(frames, Math.ceil(Math.max(...points.map((p) => p.frame))));
  const lowHz = Math.min(...points.map((p) => p.hz)),
    highHz = Math.max(...points.map((p) => p.hz));
  if (end <= start || highHz <= lowHz || (tool === "lasso" && points.length < 3)) return;
  return {
    start,
    end,
    lowHz,
    highHz,
    ...(tool === "lasso" ? { points: points.map((p) => ({ ...p })) } : {}),
  };
}
