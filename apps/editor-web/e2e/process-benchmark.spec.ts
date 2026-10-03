/// <reference lib="dom" />
import type {
  DocumentInfoResult,
  EditResult,
  HistoryListResult,
  PeaksGetResult,
  ProcessJobResult,
} from "@aae/protocol";
import { expect, test } from "@playwright/test";
import { captureKernelWorker } from "./kernel-probe.ts";

// Opt-in hardware gate. Run serially on the target laptop, never in shared CI.
if (process.env.AAE_PROCESS_BENCHMARK === "1") {
  test("measures ten-minute 48 kHz stereo yielded processing, atomic commit and painted waveforms", async ({
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
    await page.locator('[role="menuitem"][data-command-id="process.amplify"]').click();
    const dialog = page.getByRole("dialog", { name: "Amplify", exact: true });
    await expect(dialog).toBeVisible();
    // Exactly half amplitude; nonzero/nonclipping gain forces actual processing
    // and creates one history state rather than exercising the zero-gain no-op.
    await dialog.getByLabel("Gain (dB)").fill("-6.020599913279624");
    await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();

    const timing = await page.evaluate(async (sourceDocumentId) => {
      const worker = window.__aaeTest?.workers[0];
      if (!worker) throw new Error("kernel worker missing");
      type TimedCall = { method: string; startedAt: number; endedAt?: number; result?: unknown };
      const calls = new Map<number, TimedCall>();
      const nativePost = worker.postMessage;
      let rejectPending: (error: Error) => void = () => {};
      let progressEvents = 0;
      let lastProgress: ProcessJobResult | undefined;
      let lastProgressAt = 0;
      let maxProgressGapMs = 0;
      let documentReadyMs = 0;
      let started = 0;
      worker.postMessage = (
        message: unknown,
        transfer?: Transferable[] | StructuredSerializeOptions,
      ) => {
        const request = message as { id?: number; op?: string; method?: string };
        const method = request.op === "process.run" ? "process.run" : request.method;
        if (
          request.id !== undefined &&
          method &&
          ["process.start", "process.run", "process.commit"].includes(method)
        )
          calls.set(request.id, { method, startedAt: performance.now() });
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
        } else if (event.data.kind === "reply") {
          call.endedAt = performance.now();
          call.result = event.data.result;
          if (!event.data.ok) rejectPending(new Error(`${call.method}: ${event.data.error}`));
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
          maxProgressGapMs,
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
    console.info(`WASM processing benchmark: ${JSON.stringify(timing)}`);
    await test.info().attach("full-processing-timing", {
      body: JSON.stringify(timing),
      contentType: "application/json",
    });
    expect(timing.changed).toBe(true);
    expect(timing.documentId).not.toBe(source.document.documentId);
    expect(timing.ready).toMatchObject({
      state: "ready",
      operation: "gain",
      gainDb: -6.020599913279624,
      start: 0,
      end: 28_800_000,
      channelMask: 3,
      totalFrames: 28_800_000,
      processedFrames: 28_800_000,
      nonFinite: false,
    });
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
          ranges: Array.from({ length: peaks.count }, (_, index) => [starts[index], counts[index]]),
        });
      }
      return result;
    });
    for (const channel of channelPeaks) {
      expect(channel.count).toBeGreaterThan(1);
      const expected =
        channel.channel === 0 ? [-0.25, 0.248046875] : [-0.2480621337890625, 0.2499847412109375];
      for (const pair of channel.extrema) expect(pair).toEqual(expected);
      let end = 0;
      for (const [start, count] of channel.ranges) {
        expect(start).toBe(end);
        end = start + count;
      }
      expect(end).toBe(28_800_000);
    }
    expect(
      timing.totalMs,
      "ten-minute processing including yielded WASM, atomic commit and painted waveforms",
    ).toBeLessThan(1_000);
  });
}
