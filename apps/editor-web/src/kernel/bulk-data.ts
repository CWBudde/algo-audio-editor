import type { KernelMethod } from "@aae/protocol";

/** Binary bridge replies; optional jobs publish bytes only when dataBytes > 0. */
export const BULK_DATA_METHODS: Partial<
  Record<KernelMethod, { optional: boolean; refill: boolean }>
> = {
  "peaks.get": { optional: false, refill: false },
  "doc.export": { optional: false, refill: false },
  "doc.readPCM": { optional: false, refill: false },
  "timeline.export": { optional: false, refill: false },
  "process.exportCandidate": { optional: false, refill: false },
  "effects.response": { optional: false, refill: true },
  "analysis.spectrum": { optional: true, refill: true },
  "analysis.start": { optional: true, refill: true },
  "analysis.step": { optional: true, refill: true },
};
