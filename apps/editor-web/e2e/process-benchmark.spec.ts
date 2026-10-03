/// <reference lib="dom" />
import type {
  DocumentInfoResult,
  EditResult,
  HistoryListResult,
  PeaksGetResult,
  ProcessJobResult,
  ProcessStartParams,
} from "@aae/protocol";
import { expect, test } from "@playwright/test";
import { captureKernelWorker } from "./kernel-probe.ts";

// Opt-in hardware gate. Run serially on the target laptop, never in shared CI.
// AAE_PROCESS_BENCH_OPERATION=gain|normalize-peak|normalize-loudness selects
// one isolated case through the existing just bench-process-browser recipe.
if (process.env.AAE_PROCESS_BENCHMARK === "1") {
  const cases = [
    { operation: "gain", value: -6.020599913279624, phaseCount: 1 },
    { operation: "normalize-peak", value: -12.041199826559248, phaseCount: 2 },
    { operation: "normalize-loudness", value: -23, phaseCount: 3 },
  ] as const;
  const operationFilter = process.env.AAE_PROCESS_BENCH_OPERATION;
  if (operationFilter && !cases.some((item) => item.operation === operationFilter))
    throw new Error(`Invalid AAE_PROCESS_BENCH_OPERATION: ${operationFilter}`);
  for (const scenario of cases) {
    if (operationFilter && operationFilter !== scenario.operation) continue;
    test(`measures ten-minute 48 kHz stereo ${scenario.operation}, atomic commit and painted waveforms`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await captureKernelWorker(page);
      await page.goto("/");
      await expect(page.getByTestId("kernel-status")).toHaveText("kernel ready");

      // Construct and import the same varied encoded PCM16 workload as the import
      // benchmark before starting the processing clock. No samples are processed
      // by frontend code; these are merely test fixture bytes.
      await page.evaluate(async () => {
        const frames = 48_000 * 600;
        const bytes = new Uint8Array(44 + frames * 4);
        const view = new DataView(bytes.buffer);
        const text = (offset: number, value: string) => {
          for (let index = 0; index < value.length; index++)
            bytes[offset + index] = value.charCodeAt(index);
        };
        text(0, "RIFF");
        view.setUint32(4, bytes.length - 8, true);
        text(8, "WAVEfmt ");
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 2, true);
        view.setUint32(24, 48_000, true);
        view.setUint32(28, 48_000 * 4, true);
        view.setUint16(32, 4, true);
        view.setUint16(34, 16, true);
        text(36, "data");
        view.setUint32(40, bytes.length - 44, true);
        const pattern = new Uint8Array(256 * 4);
        const patternView = new DataView(pattern.buffer);
        for (let frame = 0; frame < 256; frame++) {
          patternView.setInt16(frame * 4, frame * 128 - 16384, true);
          patternView.setInt16(frame * 4 + 2, 16383 - frame * 128, true);
        }
        for (let offset = 44; offset < bytes.length; offset += pattern.length)
          bytes.set(pattern, offset);
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], "process-ten-minute.wav", { type: "audio/wav" }));
        const dropZone = document.querySelector('[data-testid="document-drop-zone"]');
        if (!dropZone) throw new Error("document drop zone missing");
        await new Promise<void>((resolve, reject) => {
          const observer = new MutationObserver(() => {
            if (
              document.querySelector('[data-testid="document-name"]')?.textContent !==
              "process-ten-minute.wav"
            )
              return;
            if (
              document.querySelectorAll('[data-testid^="waveform-channel-"][data-rendered="true"]')
                .length !== 2 ||
              document
                .querySelector('[data-testid="waveform-overview"]')
                ?.getAttribute("data-rendered") !== "true"
            )
              return;
            observer.disconnect();
            clearTimeout(timer);
            resolve();
          });
          const timer = setTimeout(() => {
            observer.disconnect();
            reject(new Error("benchmark fixture import timed out"));
          }, 90_000);
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ["data-rendered"],
          });
          dropZone.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
        });
      });
      await expect(page.getByTestId("document-details")).toContainText(
        "48000 Hz · 2 channels · 28800000 frames · 600.000 s",
      );
      const source = await page.evaluate(async () => {
        const probe = window.__aaeTest;
        if (!probe) throw new Error("kernel probe missing");
        const document = (await probe.request("doc.info")) as DocumentInfoResult;
        const history = (await probe.request("history.list", {
          documentId: document.documentId,
        })) as HistoryListResult;
        return { document, history };
      });
      await page.getByRole("menuitem", { name: "Process", exact: true }).click();
      const gain = scenario.operation === "gain";
      await page
        .locator(`[role="menuitem"][data-command-id="process.${gain ? "amplify" : "normalize"}"]`)
        .click();
      const dialog = page.getByRole("dialog", {
        name: gain ? "Amplify" : "Normalize",
        exact: true,
      });
      await expect(dialog).toBeVisible();
      if (!gain) await dialog.getByLabel("Normalization mode").selectOption(scenario.operation);
      // Gain/peak use half amplitude; LUFS must analyze and actually remeasure the
      // rendered float32 candidate. Only source fixture/import precede the clock:
      // no Preview, process.start or normalization helper prepares a candidate.
      await dialog
        .getByLabel(
          gain
            ? "Gain (dB)"
            : scenario.operation === "normalize-peak"
              ? "Target peak (dBFS)"
              : "Target loudness (LUFS)",
        )
        .fill(String(scenario.value));
      await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();

      const timing = await page.evaluate(async (sourceDocumentId) => {
        const worker = window.__aaeTest?.workers[0];
        if (!worker) throw new Error("kernel worker missing");
        type TimedCall = {
          method: string;
          startedAt: number;
          endedAt?: number;
          result?: unknown;
          params?: unknown;
        };
        type PhaseTiming = {
          phase: ProcessJobResult["phase"];
          phaseIndex: number;
          firstMs: number;
          lastMs: number;
          finishedMs?: number;
          progressCalls: number;
          planningCalls: number;
          firstFrames: number;
          lastFrames: number;
          maxProgressGapMs: number;
        };
        const calls = new Map<number, TimedCall>();
        const phases = new Map<ProcessJobResult["phase"], PhaseTiming>();
        const nativePost = worker.postMessage;
        let rejectPending: (error: Error) => void = () => {};
        let progressEvents = 0;
        let lastProgress: ProcessJobResult | undefined;
        let lastProgressAt = 0;
        let maxProgressGapMs = 0;
        let documentReadyMs = 0;
        let started = 0;
        let previousPhase: PhaseTiming | undefined;
        let previousPlanningSteps = 0;
        const recordPhase = (progress: ProcessJobResult, now: number, progressCall: boolean) => {
          let phase = phases.get(progress.phase);
          if (!phase) {
            phase = {
              phase: progress.phase,
              phaseIndex: progress.phaseIndex,
              firstMs: now - started,
              lastMs: now - started,
              progressCalls: 0,
              planningCalls: 0,
              firstFrames: progress.processedFrames,
              lastFrames: progress.processedFrames,
              maxProgressGapMs: 0,
            };
            phases.set(progress.phase, phase);
          }
          if (previousPhase && previousPhase !== phase) previousPhase.finishedMs = now - started;
          // A final bounded planning call can report the NEXT phase; attribute
          // its monotonic planningSteps delta to the phase that executed it.
          (previousPhase ?? phase).planningCalls += progress.planningSteps - previousPlanningSteps;
          previousPlanningSteps = progress.planningSteps;
          if (progressCall) {
            phase.maxProgressGapMs = Math.max(phase.maxProgressGapMs, now - started - phase.lastMs);
            phase.progressCalls++;
          }
          phase.lastMs = now - started;
          phase.lastFrames = progress.processedFrames;
          if (progress.state === "ready") phase.finishedMs = now - started;
          previousPhase = phase;
        };
        worker.postMessage = (
          message: unknown,
          transfer?: Transferable[] | StructuredSerializeOptions,
        ) => {
          const request = message as {
            id?: number;
            op?: string;
            method?: string;
            params?: unknown;
          };
          const method = request.op === "process.run" ? "process.run" : request.method;
          if (
            request.id !== undefined &&
            method &&
            ["process.start", "process.run", "process.commit"].includes(method)
          )
            calls.set(request.id, { method, startedAt: performance.now(), params: request.params });
          nativePost.call(worker, message, Array.isArray(transfer) ? { transfer } : transfer);
        };
        const onMessage = (event: MessageEvent) => {
          if (event.data.kind === "fatal") {
            rejectPending(new Error(event.data.error));
            return;
          }
          const call = calls.get(event.data.id);
          if (!call) return;
          if (event.data.kind === "process.progress" && call.method === "process.run") {
            const progress = event.data.progress as ProcessJobResult;
            if (progress.documentId !== sourceDocumentId) return;
            const now = performance.now();
            if (lastProgressAt) maxProgressGapMs = Math.max(maxProgressGapMs, now - lastProgressAt);
            lastProgressAt = now;
            lastProgress = progress;
            progressEvents++;
            recordPhase(progress, now, true);
          } else if (event.data.kind === "reply") {
            call.endedAt = performance.now();
            call.result = event.data.result;
            if (!event.data.ok) rejectPending(new Error(`${call.method}: ${event.data.error}`));
            else if (call.method === "process.start")
              recordPhase(event.data.result as ProcessJobResult, call.endedAt, false);
          }
        };
        worker.addEventListener("message", onMessage);
        try {
          await new Promise<void>((resolve, reject) => {
            rejectPending = reject;
            const observer = new MutationObserver(() => {
              const root = document.querySelector('[data-testid="waveform-view"]');
              const documentId = root?.getAttribute("data-document-id");
              if (!root || !documentId || documentId === sourceDocumentId) return;
              if (!documentReadyMs) documentReadyMs = performance.now() - started;
              const committed = Array.from(calls.values()).find(
                (call) => call.method === "process.commit",
              )?.result as EditResult | undefined;
              if (committed?.document.documentId !== documentId) return;
              if (
                root.querySelectorAll('[data-testid^="waveform-channel-"][data-rendered="true"]')
                  .length !== 2 ||
                root
                  .querySelector('[data-testid="waveform-overview"]')
                  ?.getAttribute("data-rendered") !== "true"
              )
                return;
              if (document.querySelector('dialog[open] [data-testid="process-status"]')) return;
              observer.disconnect();
              clearTimeout(timer);
              resolve();
            });
            const timer = setTimeout(() => {
              observer.disconnect();
              reject(new Error("processing benchmark timed out"));
            }, 90_000);
            const rejectOperation = rejectPending;
            rejectPending = (error) => {
              observer.disconnect();
              clearTimeout(timer);
              rejectOperation(error);
            };
            observer.observe(document.body, {
              childList: true,
              subtree: true,
              attributes: true,
              attributeFilter: ["data-rendered", "data-document-id", "open"],
            });
            const apply = Array.from(
              document.querySelectorAll<HTMLButtonElement>("dialog[open] button"),
            ).find((button) => button.textContent === "Apply");
            if (!apply || apply.disabled) {
              rejectPending(new Error("Apply unavailable"));
              return;
            }
            started = performance.now();
            apply.click();
          });
          const totalMs = performance.now() - started;
          const allCalls = Array.from(calls.values());
          const find = (method: string) => {
            const matches = allCalls.filter((call) => call.method === method);
            if (matches.length !== 1 || matches[0].endedAt === undefined)
              throw new Error(`${method}: expected exactly one completed request`);
            return matches[0] as TimedCall & { endedAt: number };
          };
          const prepare = find("process.start");
          const run = find("process.run");
          const commit = find("process.commit");
          const ready = run.result as ProcessJobResult;
          const result = commit.result as EditResult;
          return {
            frames: 48_000 * 600,
            channels: 2,
            sourceDocumentId,
            documentId: result.document.documentId,
            totalMs,
            startRpcMs: prepare.endedAt - prepare.startedAt,
            runRpcMs: run.endedAt - run.startedAt,
            commitRpcMs: commit.endedAt - commit.startedAt,
            processingAndCommitMs: commit.endedAt - run.startedAt,
            timeToStartMs: prepare.startedAt - started,
            documentReadyMs,
            commitToUiMs: started + documentReadyMs - commit.endedAt,
            waveformMs: totalMs - documentReadyMs,
            progressEvents,
            // ABI10 reports one event per bounded batch, not per DSP block.
            progressUnit: "bounded batch replies",
            maxProgressGapMs,
            phaseTimings: Array.from(phases.values(), (phase) => ({
              ...phase,
              spanMs: (phase.finishedMs ?? phase.lastMs) - phase.firstMs,
            })),
            startParams: prepare.params as ProcessStartParams,
            ready,
            lastProgress,
            history: result.history,
            changed: result.changed,
          };
        } finally {
          worker.postMessage = nativePost;
          worker.removeEventListener("message", onMessage);
        }
      }, source.document.documentId);

      // Print/attach every metric before enforcing the hardware-dependent budget.
      console.info(`WASM ${scenario.operation} benchmark: ${JSON.stringify(timing)}`);
      await test.info().attach(`full-processing-timing-${scenario.operation}`, {
        body: JSON.stringify(timing),
        contentType: "application/json",
      });
      expect(timing.changed).toBe(true);
      expect(timing.documentId).not.toBe(source.document.documentId);
      expect(timing.ready).toMatchObject({
        state: "ready",
        operation: scenario.operation,
        phaseCount: scenario.phaseCount,
        phaseIndex: scenario.phaseCount - 1,
        phase: scenario.operation === "normalize-loudness" ? "verifying" : "processing",
        gainResolved: true,
        start: 0,
        end: 28_800_000,
        channelMask: 3,
        totalFrames: 28_800_000,
        processedFrames: 28_800_000,
        nonFinite: false,
      });
      expect(timing.startParams).toMatchObject({
        operation: scenario.operation,
        documentId: source.document.documentId,
        start: 0,
        end: 0,
        channelMask: 3,
        ...(gain ? { gainDb: scenario.value } : { target: scenario.value }),
      });
      if (gain) expect(timing.ready.gainDb).toBe(scenario.value);
      else {
        expect(timing.ready.target).toBe(scenario.value);
        expect(timing.ready.inputPeak).toBe(0.5);
      }
      expect(timing.ready.gainDb).not.toBe(0);
      expect(timing.ready.unchangedReason).toBeUndefined();
      expect(timing.phaseTimings.map((phase) => phase.phase)).toEqual(
        gain
          ? ["processing"]
          : scenario.operation === "normalize-peak"
            ? ["analyzing", "processing"]
            : ["analyzing", "processing", "verifying"],
      );
      for (const phase of timing.phaseTimings) expect(phase.progressCalls).toBeGreaterThan(1);
      if (scenario.operation === "normalize-loudness") {
        expect(timing.ready.inputLufs).not.toBeNull();
        expect(
          timing.ready.outputLufs,
          "actual float32 output measurement must finish inside the clock",
        ).not.toBeNull();
        expect(
          Math.abs((timing.ready.outputLufs ?? Number.NaN) - scenario.value),
        ).toBeLessThanOrEqual(0.01);
        expect(
          timing.phaseTimings.find((phase) => phase.phase === "analyzing")?.planningCalls,
        ).toBeGreaterThan(0);
        expect(
          timing.phaseTimings.find((phase) => phase.phase === "verifying")?.planningCalls,
        ).toBeGreaterThan(0);
      }
      expect(timing.progressEvents).toBeGreaterThan(1);
      expect(timing.lastProgress).toEqual(timing.ready);
      expect(timing.history.entries).toHaveLength(source.history.entries.length + 1);
      expect(timing.history.dirty).toBe(true);
      await expect(dialog).not.toBeVisible();
      await expect(page.getByTestId("waveform-view")).toHaveAttribute(
        "data-document-id",
        timing.documentId,
      );
      // Small, kernel-computed peak replies verify both real channel transforms
      // without exporting another 230 MB or performing any sample DSP in JS.
      const channelPeaks = await page.evaluate(async () => {
        const probe = window.__aaeTest;
        if (!probe) throw new Error("kernel probe missing");
        const result = [];
        for (const channel of [0, 1]) {
          const peaks = (await probe.request("peaks.get", {
            channel,
            startFrame: 0,
            endFrame: 28_800_000,
            buckets: 1,
          })) as PeaksGetResult;
          const triples = new Float32Array(peaks.data, 0, peaks.count * 3);
          const counts = new Uint32Array(peaks.data, peaks.count * 12, peaks.count);
          const starts = new Float64Array(peaks.data, peaks.count * 16, peaks.count);
          result.push({
            channel,
            count: peaks.count,
            extrema: Array.from({ length: peaks.count }, (_, index) => [
              triples[index * 3],
              triples[index * 3 + 1],
            ]),
            ranges: Array.from({ length: peaks.count }, (_, index) => [
              starts[index],
              counts[index],
            ]),
          });
        }
        return result;
      });
      let expectedOutputPeak = 0;
      for (const channel of channelPeaks) {
        expect(channel.count).toBeGreaterThan(1);
        // Test-only scalar reference from independently known PCM16 extrema.
        const sourceExtrema =
          channel.channel === 0 ? [-0.5, 0.49609375] : [-0.496124267578125, 0.499969482421875];
        const coefficient = 10 ** (timing.ready.gainDb / 20);
        const expected = sourceExtrema.map((value) => Math.fround(value * coefficient));
        expectedOutputPeak = Math.max(expectedOutputPeak, ...expected.map(Math.abs));
        for (const pair of channel.extrema) expect(pair).toEqual(expected);
        let end = 0;
        for (const [start, count] of channel.ranges) {
          expect(start).toBe(end);
          end = start + count;
        }
        expect(end).toBe(28_800_000);
      }
      expect(timing.ready.peak).toBe(expectedOutputPeak);
      expect(
        timing.totalMs,
        `ten-minute ${scenario.operation} including analysis/planning/render/measurement, atomic commit and painted waveforms`,
      ).toBeLessThan(1_000);
    });
  }
}
