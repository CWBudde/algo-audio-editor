/// <reference lib="dom" />
import type {
  DocumentInfoResult,
  EditResult,
  HistoryListResult,
  PeaksGetResult,
  ProcessJobResult,
  ProcessStartParams,
  SelectionRange,
} from "@aae/protocol";
import { expect, type Page, test } from "@playwright/test";
import { select } from "./edit-fixture.ts";
import { captureKernelWorker } from "./kernel-probe.ts";
import { revealControl } from "./ui-disclosures.ts";

async function importTenMinute(page: Page, sourceChannels: number) {
  await page.evaluate(async (channels) => {
    const frames = 48_000 * 600;
    const bytes = new Uint8Array(44 + frames * channels * 2);
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
    view.setUint16(22, channels, true);
    view.setUint32(24, 48_000, true);
    view.setUint32(28, 48_000 * channels * 2, true);
    view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, bytes.length - 44, true);
    const pattern = new Uint8Array(256 * channels * 2);
    const patternView = new DataView(pattern.buffer);
    for (let frame = 0; frame < 256; frame++) {
      patternView.setInt16(frame * channels * 2, frame * 128 - 16384, true);
      if (channels === 2) patternView.setInt16(frame * channels * 2 + 2, 16383 - frame * 128, true);
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
            .length !== channels ||
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
  }, sourceChannels);
  await expect(page.getByTestId("document-details")).toContainText(
    `48000 Hz · ${sourceChannels} channel${sourceChannels === 1 ? "" : "s"} · 28800000 frames · 600.000 s`,
  );
  await expect(page.getByLabel("Selection end", { exact: true })).toBeEnabled();
  await (await revealControl(page.getByLabel("Time format", { exact: true }))).selectOption(
    "samples",
  );
  await page.getByLabel("Time format", { exact: true }).press("Escape");
}

// Opt-in hardware gate. Run serially on the target laptop, never in shared CI.
// AAE_PROCESS_BENCH_OPERATION selects an operation or a specific scenario ID.
// Every gate includes real Apply, commit and painted output; no Preview is used.
if (process.env.AAE_PROCESS_BENCHMARK === "1") {
  interface Scenario {
    id: string;
    operation: ProcessStartParams["operation"];
    command: string;
    title: string;
    phaseCount: number;
    value?: number;
    sourceChannels?: number;
    outputChannels?: number;
    outputFrames?: number;
    renderFrames?: number;
    selection?: SelectionRange;
    fields?: Record<string, string>;
    choices?: Record<string, string>;
  }
  const frames = 28_800_000;
  const curves = ["linear", "equal-power", "logarithmic", "s-curve"] as const;
  const cases: Scenario[] = [
    {
      id: "gain",
      operation: "gain",
      command: "amplify",
      title: "Amplify",
      value: -6.020599913279624,
      phaseCount: 1,
    },
    {
      id: "normalize-peak",
      operation: "normalize-peak",
      command: "normalize",
      title: "Normalize",
      value: -12.041199826559248,
      phaseCount: 2,
    },
    {
      id: "normalize-loudness",
      operation: "normalize-loudness",
      command: "normalize",
      title: "Normalize",
      value: -23,
      phaseCount: 3,
    },
    ...curves.flatMap((curve): Scenario[] => [
      {
        id: `fade-in-${curve}`,
        operation: "fade-in",
        command: "fade",
        title: "Fade In / Out",
        phaseCount: 1,
        choices: { Direction: "fade-in", Curve: curve },
      },
      {
        id: `fade-out-${curve}`,
        operation: "fade-out",
        command: "fade",
        title: "Fade In / Out",
        phaseCount: 1,
        choices: { Direction: "fade-out", Curve: curve },
      },
      {
        id: `crossfade-${curve}`,
        operation: "crossfade",
        command: "crossfade",
        title: "Crossfade at cursor",
        phaseCount: 1,
        outputFrames: frames - 480_000,
        renderFrames: 480_000,
        selection: { start: frames / 2, end: frames / 2, channelMask: 3 },
        fields: { "Overlap duration (seconds)": "10" },
        choices: { Curve: curve },
      },
    ]),
    { id: "reverse", operation: "reverse", command: "reverse", title: "Reverse", phaseCount: 1 },
    {
      id: "invert",
      operation: "invert",
      command: "invert",
      title: "Invert polarity",
      phaseCount: 1,
    },
    {
      id: "remove-dc",
      operation: "remove-dc",
      command: "remove-dc",
      title: "Remove DC offset",
      phaseCount: 2,
    },
    {
      id: "mono-to-stereo",
      operation: "mono-to-stereo",
      command: "mono-to-stereo",
      title: "Mono to stereo",
      phaseCount: 1,
      sourceChannels: 1,
      outputChannels: 2,
    },
    ...["mix", "left", "right"].map(
      (mode): Scenario => ({
        id: `stereo-to-mono-${mode}`,
        operation: "stereo-to-mono",
        command: "stereo-to-mono",
        title: "Stereo to mono",
        phaseCount: 1,
        outputChannels: 1,
        choices: { "Mono source": mode },
      }),
    ),
    ...["fast", "balanced", "best"].map(
      (quality): Scenario => ({
        id: `resample-${quality}`,
        operation: "resample",
        command: "resample",
        title: "Change sample rate",
        phaseCount: 1,
        outputFrames: 26_460_000,
        renderFrames: 26_460_000,
        fields: { "Sample rate (Hz)": "44100" },
        choices: { Quality: quality },
      }),
    ),
    ...["silence", "sine", "white-noise", "pink-noise", "linear-sweep", "log-sweep"].map(
      (generator): Scenario => ({
        id: `generate-${generator}`,
        operation: "generate",
        command: "generate",
        title: "Generate audio",
        phaseCount: 1,
        selection: { start: 0, end: frames, channelMask: 3 },
        choices: { Generator: generator },
      }),
    ),
  ];
  const operationFilter = process.env.AAE_PROCESS_BENCH_OPERATION;
  if (
    operationFilter &&
    operationFilter !== "extract-channel" &&
    !cases.some((item) => item.operation === operationFilter || item.id === operationFilter)
  )
    throw new Error(`Invalid AAE_PROCESS_BENCH_OPERATION: ${operationFilter}`);
  for (const scenario of cases) {
    if (
      operationFilter &&
      operationFilter !== scenario.operation &&
      operationFilter !== scenario.id
    )
      continue;
    test(`measures ten-minute 48 kHz ${scenario.id}, atomic commit and painted waveforms`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      const sourceChannels = scenario.sourceChannels ?? 2;
      const outputChannels = scenario.outputChannels ?? 2;
      const outputFrames = scenario.outputFrames ?? frames;
      const renderFrames = scenario.renderFrames ?? frames;
      const sourceSelection = scenario.selection ?? {
        start: 0,
        end: 0,
        channelMask: (1 << sourceChannels) - 1,
      };
      await captureKernelWorker(page);
      await page.goto("/");
      await expect(page.locator("[data-kernel-state]")).toHaveAttribute(
        "data-kernel-state",
        "ready",
      );

      // Construct and import the same varied encoded PCM16 workload as the import
      // benchmark before starting the processing clock. No samples are processed
      // by frontend code; these are merely test fixture bytes.
      await importTenMinute(page, sourceChannels);
      const source = await page.evaluate(async () => {
        const probe = window.__aaeTest;
        if (!probe) throw new Error("kernel probe missing");
        const document = (await probe.request("doc.info")) as DocumentInfoResult;
        const history = (await probe.request("history.list", {
          documentId: document.documentId,
        })) as HistoryListResult;
        return { document, history };
      });
      if (scenario.selection) await select(page, sourceSelection.start, sourceSelection.end);
      await page.getByRole("menuitem", { name: "Process", exact: true }).click();
      const value = scenario.value ?? 0;
      const gain = scenario.operation === "gain";
      const normalize =
        scenario.operation === "normalize-peak" || scenario.operation === "normalize-loudness";
      await page
        .locator(`[role="menuitem"][data-command-id="process.${scenario.command}"]`)
        .click();
      const dialog = page.getByRole("dialog", {
        name: scenario.title,
        exact: true,
      });
      await expect(dialog).toBeVisible();
      if (normalize) await dialog.getByLabel("Normalization mode").selectOption(scenario.operation);
      // Gain/peak use half amplitude; LUFS must analyze and actually remeasure the
      // rendered float32 candidate. Only source fixture/import precede the clock:
      // no Preview, process.start or normalization helper prepares a candidate.
      if (gain || normalize)
        await dialog
          .getByLabel(
            gain
              ? "Gain (dB)"
              : scenario.operation === "normalize-peak"
                ? "Target peak (dBFS)"
                : "Target loudness (LUFS)",
          )
          .fill(String(value));
      for (const [label, value] of Object.entries(scenario.fields ?? {}))
        await dialog.getByLabel(label, { exact: true }).fill(value);
      for (const [label, value] of Object.entries(scenario.choices ?? {}))
        await dialog.getByLabel(label, { exact: true }).selectOption(value);
      await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();

      const timing = await page.evaluate(
        async ({ sourceDocumentId, outputChannels }) => {
          const worker = window.__aaeTest?.workers[0];
          if (!worker) throw new Error("kernel worker missing");
          type TimedCall = import("../src/kernel/process-probe.ts").ProcessProbeCall;
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
          const phases = new Map<ProcessJobResult["phase"], PhaseTiming>();
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
            (previousPhase ?? phase).planningCalls +=
              progress.planningSteps - previousPlanningSteps;
            previousPlanningSteps = progress.planningSteps;
            if (progressCall) {
              phase.maxProgressGapMs = Math.max(
                phase.maxProgressGapMs,
                now - started - phase.lastMs,
              );
              phase.progressCalls++;
            }
            phase.lastMs = now - started;
            phase.lastFrames = progress.processedFrames;
            if (progress.state === "ready") phase.finishedMs = now - started;
            previousPhase = phase;
          };
          const probe = window.__aaeProcessProbe;
          if (!probe) throw new Error("processing probe missing");
          const observation = probe.observe(worker, {
            methods: ["process.start", "process.run", "process.commit"],
            onError: (error) => rejectPending(error),
            onProgress: (progress) => {
              if (progress.documentId !== sourceDocumentId) return;
              const now = performance.now();
              if (lastProgressAt)
                maxProgressGapMs = Math.max(maxProgressGapMs, now - lastProgressAt);
              lastProgressAt = now;
              lastProgress = progress;
              progressEvents++;
              recordPhase(progress, now, true);
            },
            onReply: (call) => {
              if (call.method === "process.start")
                recordPhase(
                  call.result as ProcessJobResult,
                  call.endedAt ?? performance.now(),
                  false,
                );
            },
          });
          const { calls } = observation;
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
                    .length !== outputChannels ||
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
            observation.dispose();
          }
        },
        { sourceDocumentId: source.document.documentId, outputChannels },
      );

      // Print/attach every metric before enforcing the hardware-dependent budget.
      console.info(`WASM ${scenario.id} benchmark: ${JSON.stringify(timing)}`);
      await test.info().attach(`full-processing-timing-${scenario.id}`, {
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
        start: scenario.operation === "crossfade" ? sourceSelection.start : 0,
        end: scenario.operation === "crossfade" ? sourceSelection.end : frames,
        channelMask: (1 << sourceChannels) - 1,
        totalFrames: renderFrames,
        processedFrames: renderFrames,
        nonFinite: false,
      });
      expect(timing.startParams).toMatchObject({
        operation: scenario.operation,
        documentId: source.document.documentId,
        ...sourceSelection,
        ...(gain ? { gainDb: scenario.value } : normalize ? { target: scenario.value } : {}),
      });
      if (gain) expect(timing.ready.gainDb).toBe(scenario.value);
      else if (normalize) {
        expect(timing.ready.target).toBe(scenario.value);
        expect(timing.ready.inputPeak).toBe(0.5);
      }
      if (gain || normalize) expect(timing.ready.gainDb).not.toBe(0);
      expect(timing.ready.unchangedReason).toBeUndefined();
      expect(timing.phaseTimings.map((phase) => phase.phase)).toEqual(
        scenario.phaseCount === 1
          ? ["processing"]
          : scenario.phaseCount === 2
            ? ["analyzing", "processing"]
            : ["analyzing", "processing", "verifying"],
      );
      for (const phase of timing.phaseTimings) {
        // Actual output is metered during materialization; finalization can
        // finish in one verification reply while its measurement remains real.
        expect(phase.progressCalls).toBeGreaterThan(phase.phase === "verifying" ? 0 : 1);
      }
      if (scenario.operation === "normalize-loudness") {
        expect(timing.ready.inputLufs).not.toBeNull();
        expect(
          timing.ready.outputLufs,
          "actual float32 output measurement must finish inside the clock",
        ).not.toBeNull();
        expect(Math.abs((timing.ready.outputLufs ?? Number.NaN) - value)).toBeLessThanOrEqual(0.01);
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
      const channelPeaks = await page.evaluate(
        async ({ outputFrames, outputChannels }) => {
          const probe = window.__aaeTest;
          if (!probe) throw new Error("kernel probe missing");
          const processingProbe = window.__aaeProcessProbe;
          if (!processingProbe) throw new Error("processing probe missing");
          const result = [];
          for (let channel = 0; channel < outputChannels; channel++) {
            const peaks = (await probe.request("peaks.get", {
              channel,
              startFrame: 0,
              endFrame: outputFrames,
              buckets: 1,
            })) as PeaksGetResult;
            result.push({ channel, ...processingProbe.summarizePeaks(peaks) });
          }
          return result;
        },
        { outputFrames, outputChannels },
      );
      let actualOutputPeak = 0;
      for (const channel of channelPeaks) {
        expect(channel.count).toBeGreaterThan(1);
        const sourceExtrema = [
          [-0.5, 0.49609375],
          [-0.496124267578125, 0.499969482421875],
        ];
        // Small independent scalar references validate the known PCM16 fixture
        // without exporting hundreds of MB or processing frontend samples.
        let expected: number[] | undefined;
        const channelMode = scenario.choices?.["Mono source"];
        if (gain || normalize)
          expected = sourceExtrema[channel.channel].map((value) =>
            Math.fround(value * 10 ** (timing.ready.gainDb / 20)),
          );
        else if (scenario.operation === "reverse") expected = sourceExtrema[channel.channel];
        else if (scenario.operation === "invert")
          expected = [-sourceExtrema[channel.channel][1], -sourceExtrema[channel.channel][0]];
        else if (scenario.operation === "remove-dc") expected = [-0.498046875, 0.498046875];
        else if (scenario.operation === "mono-to-stereo") expected = sourceExtrema[0];
        else if (scenario.operation === "stereo-to-mono")
          expected =
            channelMode === "mix"
              ? [-0.0000152587890625, -0.0000152587890625]
              : sourceExtrema[channelMode === "right" ? 1 : 0];
        else if (scenario.operation === "generate" && scenario.choices?.Generator === "silence")
          expected = [0, 0];
        for (const pair of channel.extrema) {
          if (expected) expect(pair).toEqual(expected);
          for (const value of pair) {
            expect(Number.isFinite(value)).toBe(true);
            actualOutputPeak = Math.max(actualOutputPeak, Math.abs(value));
          }
        }
        let end = 0;
        for (const [start, count] of channel.ranges) {
          expect(start).toBe(end);
          end = start + count;
        }
        expect(end).toBe(outputFrames);
      }
      expect(timing.ready.peak).toBe(actualOutputPeak);
      if (scenario.operation.startsWith("fade-")) expect(actualOutputPeak).toBeLessThanOrEqual(0.5);
      if (scenario.operation === "crossfade") {
        const curve = scenario.choices?.Curve;
        const bound =
          curve === "logarithmic" ? Math.log10(5.5) : curve === "equal-power" ? Math.SQRT1_2 : 0.5;
        expect(actualOutputPeak).toBeLessThanOrEqual(bound + 1e-7);
      }
      if (scenario.operation === "generate" && scenario.choices?.Generator === "sine")
        expect(actualOutputPeak).toBeCloseTo(10 ** (-12 / 20), 6);
      expect(
        timing.totalMs,
        `ten-minute ${scenario.id} including analysis/planning/render/measurement, atomic commit and painted waveforms`,
      ).toBeLessThan(1_000);
    });
  }
  if (!operationFilter || operationFilter === "extract-channel") {
    test("measures ten-minute channel extraction through binary handoff and painted destination", async ({
      page,
      context,
    }) => {
      test.setTimeout(120_000);
      await captureKernelWorker(context);
      // Browser-observed destination paint excludes Playwright polling overhead.
      await context.addInitScript(() => {
        // Popup init scripts can run against the initial about:blank document,
        // which navigation replaces. Reattach to the current document when it
        // loads; extraction also clears its URL token before React mounts.
        const painted = () => {
          const parent = window.opener as Window | null;
          if (!parent) return;
          const root = document.querySelector('[data-testid="waveform-view"]');
          if (
            !root?.getAttribute("data-document-id") ||
            root.querySelectorAll('[data-testid^="waveform-channel-"][data-rendered="true"]')
              .length !== 1 ||
            root
              .querySelector('[data-testid="waveform-overview"]')
              ?.getAttribute("data-rendered") !== "true"
          )
            return;
          observer.disconnect();
          window.removeEventListener("DOMContentLoaded", attach);
          parent.postMessage(
            {
              type: "aae.benchmark.extraction-painted",
              documentId: root.getAttribute("data-document-id"),
            },
            window.location.origin,
          );
        };
        const observer = new MutationObserver(painted);
        const attach = () => {
          observer.disconnect();
          observer.observe(document, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["data-rendered", "data-document-id"],
          });
          painted();
        };
        window.addEventListener("DOMContentLoaded", attach);
        attach();
      });
      await page.goto("/");
      await expect(page.locator("[data-kernel-state]")).toHaveAttribute(
        "data-kernel-state",
        "ready",
      );
      await importTenMinute(page, 2);
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
      await page.locator('[role="menuitem"][data-command-id="process.extract-channel"]').click();
      const dialog = page.getByRole("dialog", { name: "Extract channel", exact: true });
      await dialog.getByLabel("Channel", { exact: true }).selectOption("1");
      await expect(
        dialog.getByRole("button", { name: "Open extracted channel", exact: true }),
      ).toBeEnabled();
      const popup = page.waitForEvent("popup");
      const timingPromise = page.evaluate(async () => {
        const worker = window.__aaeTest?.workers[0];
        if (!worker) throw new Error("kernel worker missing");
        let progressEvents = 0;
        let ready: ProcessJobResult | undefined;
        let exportedBytes = 0;
        const probe = window.__aaeProcessProbe;
        if (!probe) throw new Error("processing probe missing");
        const observation = probe.observe(worker, {
          methods: [
            "process.start",
            "process.run",
            "process.exportCandidate",
            "process.commit",
            "process.cancel",
          ],
          onProgress: (progress) => {
            progressEvents++;
            ready = progress;
          },
          onReply: (call) => {
            if (call.method === "process.exportCandidate")
              exportedBytes = (call.result as { dataBytes: number }).dataBytes;
          },
        });
        const { calls } = observation;
        let started = 0;
        try {
          const destinationDocumentId = await new Promise<string>((resolve, reject) => {
            const painted = (event: MessageEvent) => {
              if (
                event.origin !== window.location.origin ||
                event.data?.type !== "aae.benchmark.extraction-painted"
              )
                return;
              clearTimeout(timer);
              window.removeEventListener("message", painted);
              resolve(String(event.data.documentId));
            };
            const timer = setTimeout(() => {
              window.removeEventListener("message", painted);
              reject(new Error("extraction paint timed out"));
            }, 90_000);
            window.addEventListener("message", painted);
            const apply = Array.from(
              document.querySelectorAll<HTMLButtonElement>("dialog[open] button"),
            ).find((button) => button.textContent === "Open extracted channel");
            if (!apply || apply.disabled) {
              clearTimeout(timer);
              window.removeEventListener("message", painted);
              reject(new Error("extraction Apply unavailable"));
              return;
            }
            started = performance.now();
            apply.click();
          });
          return {
            totalMs: performance.now() - started,
            destinationDocumentId,
            exportedBytes,
            progressEvents,
            ready,
            calls: Array.from(calls.values()).map((call) => ({
              method: call.method,
              rpcMs: call.endedAt === undefined ? null : call.endedAt - call.startedAt,
            })),
          };
        } finally {
          observation.dispose();
        }
      });
      const [timing, destination] = await Promise.all([timingPromise, popup]);
      console.info(`WASM extract-channel benchmark: ${JSON.stringify(timing)}`);
      await test.info().attach("full-processing-timing-extract-channel", {
        body: JSON.stringify(timing),
        contentType: "application/json",
      });
      expect(timing.exportedBytes).toBe(frames * 4);
      expect(timing.ready).toMatchObject({
        operation: "extract-channel",
        state: "ready",
        processedFrames: frames,
        totalFrames: frames,
        nonFinite: false,
        candidate: { channels: 1, sampleRate: 48000, frames },
      });
      expect(timing.calls.filter((call) => call.method === "process.start")).toHaveLength(1);
      expect(timing.calls.filter((call) => call.method === "process.run")).toHaveLength(1);
      expect(timing.calls.filter((call) => call.method === "process.exportCandidate")).toHaveLength(
        1,
      );
      expect(timing.calls.filter((call) => call.method === "process.commit")).toHaveLength(0);
      await expect(dialog).not.toBeVisible();
      await expect(destination.getByTestId("waveform-view")).toHaveAttribute(
        "data-document-id",
        timing.destinationDocumentId,
      );
      const output = await destination.evaluate(async () => {
        const probe = window.__aaeTest;
        if (!probe) throw new Error("destination kernel probe missing");
        const document = (await probe.request("doc.info")) as DocumentInfoResult;
        const history = (await probe.request("history.list", {
          documentId: document.documentId,
        })) as HistoryListResult;
        const peaks = (await probe.request("peaks.get", {
          channel: 0,
          startFrame: 0,
          endFrame: document.frames,
          buckets: 1,
        })) as PeaksGetResult;
        const processingProbe = window.__aaeProcessProbe;
        if (!processingProbe) throw new Error("processing probe missing");
        return {
          document,
          history,
          extrema: processingProbe.summarizePeaks(peaks).extrema,
        };
      });
      expect(output.document).toMatchObject({ channels: 1, sampleRate: 48000, frames });
      expect(output.history.dirty).toBe(true);
      for (const pair of output.extrema)
        expect(pair).toEqual([-0.496124267578125, 0.499969482421875]);
      const unchanged = await page.evaluate(async () => {
        const probe = window.__aaeTest;
        if (!probe) throw new Error("source kernel probe missing");
        const document = (await probe.request("doc.info")) as DocumentInfoResult;
        const history = (await probe.request("history.list", {
          documentId: document.documentId,
        })) as HistoryListResult;
        return { document, history };
      });
      expect(unchanged).toEqual(source);
      await destination.close();
      expect(
        timing.totalMs,
        "ten-minute extraction including binary export/import and painted destination",
      ).toBeLessThan(1_000);
    });
  }
}
