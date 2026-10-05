/// <reference lib="dom" />

import type { AnalysisJobResult, DocumentInfoResult, HistoryListResult } from "@aae/protocol";
import { expect, test } from "@playwright/test";
import { captureKernelWorker } from "./kernel-probe.ts";

// Actual codec import is deliberately serial/opt-in: it retains ~1.5 GiB in
// the WASM worker. Generate this real file with just flac-hour-fixture PATH.
const fixture = process.env.AAE_HOUR_FLAC_FIXTURE;
if (fixture) {
  test("imports one-hour stereo FLAC and paints the complete waveform", async ({ page }) => {
    test.setTimeout(900_000);
    await captureKernelWorker(page);
    await page.goto("/");
    await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
    const started = Date.now();
    await page.getByTestId("audio-file-input").setInputFiles(fixture);
    await expect(page.getByTestId("document-details")).toContainText(
      "48000 Hz · 2 channels · 172800000 frames · 3600.000 s",
      { timeout: 600_000 },
    );
    await expect(page.getByTestId("waveform-channel-0")).toHaveAttribute("data-rendered", "true");
    await expect(page.getByTestId("waveform-channel-1")).toHaveAttribute("data-rendered", "true");
    await expect(page.getByTestId("waveform-overview")).toHaveAttribute("data-rendered", "true");
    const importToPaintMs = Date.now() - started;
    const result = await page.evaluate(async () => {
      const probe = window.__aaeTest;
      if (!probe) throw new Error("kernel probe missing");
      const info = (await probe.request("doc.info")) as DocumentInfoResult;
      const history = (await probe.request("history.list", {
        documentId: info.documentId,
      })) as HistoryListResult;
      const memory = (await probe.request("doc.memory")) as {
        sampleBytes: number;
        peakBytes: number;
        uniqueBlocks: number;
      };
      // Read actual WASM PCM at start, middle, end and many codec boundaries.
      // This only validates binary copies; the frontend computes no DSP.
      const starts = [0, 4095, 4096, 1_048_575, 86_400_000, 172_795_903, 172_799_998];
      for (const start of starts) {
        const page = (await probe.request("doc.readPCM", {
          documentId: info.documentId,
          stateId: history.currentStateId,
          start,
          frames: 2,
          channelMask: 3,
        })) as { data: ArrayBuffer };
        const samples = new Float32Array(page.data);
        for (let channel = 0; channel < 2; channel++) {
          for (let i = 0; i < 2; i++) {
            const value = Math.floor((start + i) / 4096) % 256;
            const integer = channel === 0 ? (value - 128) * 16384 : (127 - value) * 8192 + 17;
            if (samples[channel * 2 + i] !== integer / 2 ** 23)
              throw new Error(`incorrect FLAC PCM at channel ${channel}, frame ${start + i}`);
          }
        }
      }
      return { info, history, memory, import: probe.openTimings[0] };
    });
    expect(result.info).toMatchObject({
      format: "flac",
      sampleRate: 48000,
      channels: 2,
      frames: 172_800_000,
      bitDepth: 24,
      float: false,
    });
    expect(result.history.dirty).toBe(false);
    expect(result.history.entries).toHaveLength(1);
    expect(result.memory.sampleBytes).toBe(172_800_000 * 8);
    expect(result.memory.uniqueBlocks).toBe(2 * Math.ceil(172_800_000 / 4096));
    const report = { ...result, importToPaintMs };
    console.info(`one-hour FLAC acceptance: ${JSON.stringify(report)}`);
    await test.info().attach("one-hour-flac", {
      body: JSON.stringify(report, null, 2),
      contentType: "application/json",
    });
    // Observe calls inside the real worker: analysis.run is one main-thread
    // request but performs many JS→Go calls. Counting postMessage would hide it.
    const worker = page.workers()[0];
    if (!worker) throw new Error("production kernel worker missing");
    for (const kind of ["statistics", "clipping", "spectrum", "spectrogram"] as const) {
      await worker.evaluate(() => {
        const scope = globalThis as typeof globalThis & {
          AAEKernel: {
            call(method: string, params?: string, input?: Uint8Array): string;
          };
          __analysisMeasurement?: {
            calls: number;
            maxMs: number;
            totalMs: number;
            restore(): void;
          };
        };
        const bridge = scope.AAEKernel;
        const original = bridge.call;
        const measurement = {
          calls: 0,
          maxMs: 0,
          totalMs: 0,
          restore: () => {
            bridge.call = original;
          },
        };
        scope.__analysisMeasurement = measurement;
        bridge.call = (method, params, input) => {
          const started = performance.now();
          try {
            return original.call(bridge, method, params, input);
          } finally {
            if (method === "analysis.step") {
              const elapsed = performance.now() - started;
              measurement.calls++;
              measurement.maxMs = Math.max(measurement.maxMs, elapsed);
              measurement.totalMs += elapsed;
            }
          }
        };
      });
      const run = await page.evaluate(
        async ({ documentId, kind }) => {
          const probe = window.__aaeTest;
          if (!probe) throw new Error("kernel probe missing");
          const job = (await probe.request("analysis.start", {
            documentId,
            kind,
            start: 0,
            end: 172_800_000,
            channelMask: 3,
            fftSize: 2048,
            window: "hann",
            averaging: 64,
            channel: 0,
            width: 128,
            height: 160,
            minDB: -100,
          })) as AnalysisJobResult;
          const started = performance.now();
          const result = await new Promise<AnalysisJobResult>((resolve, reject) => {
            const worker = probe.workers[0];
            const id = -900_000;
            const timer = setTimeout(() => {
              worker.removeEventListener("message", receive);
              reject(new Error("analysis benchmark timeout"));
            }, 600_000);
            function receive(event: MessageEvent) {
              if (event.data.kind !== "reply" || event.data.id !== id) return;
              clearTimeout(timer);
              worker.removeEventListener("message", receive);
              if (event.data.ok) resolve(event.data.result as AnalysisJobResult);
              else reject(new Error(event.data.error));
            }
            worker.addEventListener("message", receive);
            worker.postMessage({ id, op: "analysis.run", documentId, jobId: job.jobId });
          });
          const elapsedMs = performance.now() - started;
          await probe.request("analysis.cancel", { documentId, jobId: job.jobId });
          return { elapsedMs, processedFrames: result.processedFrames, state: result.state };
        },
        { documentId: result.info.documentId, kind },
      );
      const counts = await worker.evaluate(() => {
        const scope = globalThis as typeof globalThis & {
          __analysisMeasurement: { calls: number; maxMs: number; totalMs: number; restore(): void };
        };
        const { calls, maxMs, totalMs } = scope.__analysisMeasurement;
        scope.__analysisMeasurement.restore();
        return { stepCalls: calls, maxStepMs: maxMs, meanStepMs: totalMs / calls };
      });
      expect(run.state).toBe("ready");
      expect(run.processedFrames).toBe(172_800_000);
      expect(counts.stepCalls).toBeGreaterThan(0);
      const measurement = { kind, ...run, ...counts, mainWorkerRequests: 3 };
      console.info(`one-hour browser analysis: ${JSON.stringify(measurement)}`);
      await test.info().attach(`one-hour-${kind}`, {
        body: JSON.stringify(measurement, null, 2),
        contentType: "application/json",
      });
    }
  });
}
