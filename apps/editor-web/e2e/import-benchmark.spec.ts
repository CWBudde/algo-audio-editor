/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import { captureKernelWorker } from "./kernel-probe.ts";

// Opt-in benchmark: run in isolation with AAE_IMPORT_BENCHMARK=1 and --workers=1.
// Verify the target-laptop budget; hardware-dependent thresholds do not belong in CI.
if (process.env.AAE_IMPORT_BENCHMARK === "1") {
  test("measures a ten-minute 48 kHz stereo PCM16 import in WASM", async ({ page }) => {
    test.setTimeout(120_000);
    await captureKernelWorker(page);
    await page.goto("/");
    await expect(page.getByTestId("kernel-status")).toHaveText("kernel ready");
    const timing = await page.evaluate(async () => {
      const frames = 48_000 * 600;
      const dataBytes = frames * 2 * 2;
      const bytes = new Uint8Array(44 + dataBytes);
      const view = new DataView(bytes.buffer);
      const text = (offset: number, value: string) => {
        for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
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
      view.setUint32(40, dataBytes, true);
      // Build varied encoded PCM fixture bytes before measuring import; both
      // channels exercise decoding and peak scans over the entire file.
      const pattern = new Uint8Array(256 * 4);
      const patternView = new DataView(pattern.buffer);
      for (let frame = 0; frame < 256; frame++) {
        patternView.setInt16(frame * 4, frame * 128 - 16384, true);
        patternView.setInt16(frame * 4 + 2, 16383 - frame * 128, true);
      }
      for (let offset = 44; offset < bytes.length; offset += pattern.length)
        bytes.set(pattern, offset);
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], "ten-minute.wav", { type: "audio/wav" }));
      const started = performance.now();
      let documentReadyMs = 0;
      let fileReadMs = 0;
      const readFile = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = async function () {
        const readStarted = performance.now();
        try {
          return await readFile.call(this);
        } finally {
          fileReadMs = performance.now() - readStarted;
        }
      };
      await new Promise<void>((resolve, reject) => {
        const observer = new MutationObserver(() => {
          if (
            document.querySelector('[data-testid="document-name"]')?.textContent !==
            "ten-minute.wav"
          )
            return;
          if (documentReadyMs === 0) documentReadyMs = performance.now() - started;
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
          reject(new Error("import benchmark timed out"));
        }, 90_000);
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ["data-rendered"],
        });
        document
          .querySelector('[data-testid="document-drop-zone"]')
          ?.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
      }).finally(() => {
        File.prototype.arrayBuffer = readFile;
      });
      const elapsedMs = performance.now() - started;
      const rpc = window.__aaeTest?.openTimings[0];
      if (!rpc) throw new Error("import RPC timing missing");
      return {
        bytes: bytes.length,
        frames,
        totalMs: elapsedMs,
        documentReadyMs,
        fileReadMs,
        timeToRpcMs: rpc.startedAt - started,
        rpcMs: rpc.rpcMs,
        documentUiMs: started + documentReadyMs - rpc.endedAt,
        waveformMs: elapsedMs - documentReadyMs,
        readAndUiMs: elapsedMs - rpc.rpcMs,
      };
    });
    await expect(page.getByTestId("document-details")).toContainText(
      "48000 Hz · 2 channels · 28800000 frames · 600.000 s",
    );
    console.info(`WASM import benchmark: ${JSON.stringify(timing)}`);
    await test.info().attach("full-import-timing", {
      body: JSON.stringify(timing),
      contentType: "application/json",
    });
    expect(
      timing.totalMs,
      "ten-minute import including file read and painted waveforms",
    ).toBeLessThan(1_000);
  });
}
