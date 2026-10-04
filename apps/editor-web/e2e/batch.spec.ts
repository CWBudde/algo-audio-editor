/// <reference lib="dom" />
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { DocumentInfoResult, ExportResult, HistoryListResult } from "@aae/protocol";
import { expect, type Page, test } from "@playwright/test";
import { fixture, info, load, samples } from "./edit-fixture.ts";
import { captureKernelWorker } from "./kernel-probe.ts";

const run = promisify(execFile);
const frames = 48_000;
const chain = {
  version: 1,
  operations: [
    {
      method: "process.start",
      range: "document",
      params: { operation: "normalize-loudness", target: -16 },
    },
    {
      method: "process.start",
      params: { operation: "fade-in", start: 0, end: 480, curve: "linear" },
    },
    {
      method: "process.start",
      params: { operation: "fade-out", start: frames - 480, end: frames, curve: "linear" },
    },
    {
      method: "process.start",
      range: "document",
      params: { operation: "resample", sampleRate: 44_100, quality: "balanced" },
    },
  ],
};

declare global {
  interface Window {
    __aaeBatchOutput: {
      files: Record<string, number[]>;
      holdWrites: boolean;
      pendingWrite: boolean;
      releaseWrite?: () => void;
      workersStarted: number;
      workersTerminated: number;
    };
  }
}

async function batchDialog(page: Page, folder = true) {
  await page.getByRole("menuitem", { name: "File", exact: true }).click();
  await page.locator('[role="menuitem"][data-command-id="file.batch"]').click();
  const dialog = page.getByRole("dialog", { name: "Batch processing", exact: true });
  await expect(dialog).toBeVisible();
  if (folder)
    await dialog.getByRole("button", { name: "Choose output folder", exact: true }).click();
  return dialog;
}

async function editorSnapshot(page: Page) {
  const document = await info(page);
  const history = await page.evaluate(async () => {
    const document = (await window.__aaeTest?.request("doc.info")) as DocumentInfoResult;
    return (await window.__aaeTest?.request("history.list", {
      documentId: document.documentId,
    })) as HistoryListResult;
  });
  return { document, history, samples: await samples(page) };
}

test.beforeEach(async ({ page }) => {
  await captureKernelWorker(page);
  await page.addInitScript(() => {
    const output: Window["__aaeBatchOutput"] = {
      files: {},
      holdWrites: false,
      pendingWrite: false,
      workersStarted: 0,
      workersTerminated: 0,
    };
    window.__aaeBatchOutput = output;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      private terminated = false;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        output.workersStarted++;
      }
      override terminate() {
        if (!this.terminated) output.workersTerminated++;
        this.terminated = true;
        super.terminate();
      }
    };
    // Only the browser-owned destination is supplied by the harness. Every
    // decode, processing operation and FLAC byte comes from production WASM.
    Object.assign(window, {
      showDirectoryPicker: async () => ({
        name: "Batch acceptance outputs",
        getFileHandle: async (name: string, options?: { create?: boolean }) => {
          if (!options?.create && !(name in output.files))
            throw new DOMException("File does not exist", "NotFoundError");
          return {
            createWritable: async () => {
              let bytes: number[] = [];
              return {
                write: async (blob: Blob) => {
                  bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
                  if (output.holdWrites) {
                    output.pendingWrite = true;
                    await new Promise<void>((resolveWrite) => {
                      output.releaseWrite = resolveWrite;
                    });
                    output.pendingWrite = false;
                  }
                },
                close: async () => {
                  output.files[name] = bytes;
                },
                abort: async () => {
                  bytes = [];
                },
              };
            },
          };
        },
      }),
    });
  });
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
});

test("100 real worker outputs match the native CLI after loudness normalization, fades and resampling", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  await load(page);
  const before = await editorSnapshot(page);
  const directory = testInfo.outputPath("native");
  await mkdir(directory, { recursive: true });
  const chainPath = resolve(directory, "chain.json");
  await writeFile(chainPath, JSON.stringify(chain));
  const inputs: { name: string; mimeType: string; buffer: Buffer }[] = [];
  const args = [
    "--output-dir",
    directory,
    "--allow-write",
    directory,
    "--chain",
    chainPath,
    "--format",
    "flac",
    "--bit-depth",
    "16",
  ];
  for (let index = 0; index < 100; index++) {
    const channels = [0, 1].map((channel) =>
      Array.from(
        { length: frames },
        (_, frame) =>
          // Deterministic fixture construction, before either runtime processes it.
          0.22 * Math.sin((2 * Math.PI * (137 + index * 3 + channel * 53) * frame) / 48_000) +
          0.06 * Math.sin((2 * Math.PI * (701 + index + channel * 97) * frame) / 48_000),
      ),
    );
    const name = `input-${String(index).padStart(3, "0")}.wav`;
    const buffer = fixture(channels);
    const path = resolve(directory, name);
    await writeFile(path, buffer);
    args.push("--input", path);
    inputs.push({ name, mimeType: "audio/wav", buffer });
  }
  // `just e2e` builds this executable from the same checkout as kernel.wasm.
  const native = await run(resolve("../../packages/kernel/bin/aae"), args, { timeout: 120_000 });
  const results = native.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(results).toHaveLength(100);
  expect(results.every((result) => result.applied === 4 && !result.error)).toBe(true);

  const dialog = await batchDialog(page);
  await dialog.getByLabel("Batch audio files", { exact: true }).setInputFiles(inputs);
  await dialog.getByLabel("Import batch chain", { exact: true }).setInputFiles({
    name: "mastering.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(chain)),
  });
  await dialog.getByLabel("Batch output format", { exact: true }).selectOption("flac");
  await dialog.getByLabel("Batch bit depth", { exact: true }).selectOption("16");
  await dialog.getByRole("button", { name: "Start batch", exact: true }).click();
  await expect(dialog.getByRole("status", { name: "Batch progress" })).toHaveText(
    "100 of 100 files completed · 100 succeeded · 0 failed · 0 cancelled · Finished",
    { timeout: 180_000 },
  );
  expect(await page.evaluate(() => Object.keys(window.__aaeBatchOutput.files).length)).toBe(100);
  for (let index = 0; index < 100; index++) {
    const name = `input-${String(index).padStart(3, "0")}-processed.flac`;
    const actual = Buffer.from(
      await page.evaluate((name) => window.__aaeBatchOutput.files[name], name),
    );
    const expected = await readFile(resolve(directory, name));
    expect(actual.subarray(0, 4).toString()).toBe("fLaC");
    expect(actual.equals(expected), `byte-for-byte native parity for ${name}`).toBe(true);
    await expect(dialog.getByTestId(`batch-file-${index}`)).toContainText("Done");
  }
  expect(await editorSnapshot(page)).toEqual(before);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const output = window.__aaeBatchOutput;
        return output.workersStarted - output.workersTerminated;
      }),
    )
    .toBe(1);
});

test("a corrupt input fails independently and later files still export without changing the editor", async ({
  page,
}, testInfo) => {
  await load(page);
  const before = await editorSnapshot(page);
  const dialog = await batchDialog(page);
  await dialog.getByLabel("Batch output format", { exact: true }).selectOption("wav");
  await dialog.getByLabel("Batch audio files", { exact: true }).setInputFiles([
    { name: "first.wav", mimeType: "audio/wav", buffer: fixture() },
    { name: "broken.wav", mimeType: "audio/wav", buffer: Buffer.from("invalid WAV file") },
    { name: "last.wav", mimeType: "audio/wav", buffer: fixture() },
  ]);
  await dialog.getByRole("button", { name: "Start batch", exact: true }).click();
  await expect(dialog.getByRole("status", { name: "Batch progress" })).toHaveText(
    "3 of 3 files completed · 2 succeeded · 1 failed · 0 cancelled · Finished",
    { timeout: 30_000 },
  );
  await expect(dialog.getByTestId("batch-file-0")).toContainText("Done");
  await expect(dialog.getByTestId("batch-file-1")).toContainText("Failed");
  await expect(dialog.getByTestId("batch-file-2")).toContainText("Done");
  expect(await page.evaluate(() => Object.keys(window.__aaeBatchOutput.files).sort())).toEqual([
    "first-processed.wav",
    "last-processed.wav",
  ]);
  expect(await editorSnapshot(page)).toEqual(before);
  await dialog.screenshot({ path: testInfo.outputPath("batch-desktop.png") });
  await page.setViewportSize({ width: 640, height: 720 });
  await expect
    .poll(() => dialog.evaluate((element) => element.scrollWidth <= element.clientWidth))
    .toBe(true);
  await dialog.screenshot({ path: testInfo.outputPath("batch-narrow.png") });
});

test("cancelling during a save retains that output, skips pending files and disposes the batch worker", async ({
  page,
}) => {
  await load(page);
  const before = await editorSnapshot(page);
  const dialog = await batchDialog(page);
  await dialog.getByLabel("Batch output format", { exact: true }).selectOption("wav");
  await dialog.getByLabel("Batch audio files", { exact: true }).setInputFiles([
    { name: "saved.wav", mimeType: "audio/wav", buffer: fixture() },
    { name: "skipped.wav", mimeType: "audio/wav", buffer: fixture() },
  ]);
  await page.evaluate(() => {
    window.__aaeBatchOutput.holdWrites = true;
  });
  await dialog.getByRole("button", { name: "Start batch", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__aaeBatchOutput.pendingWrite)).toBe(true);
  await dialog.getByRole("button", { name: "Cancel batch", exact: true }).click();
  await page.evaluate(() => window.__aaeBatchOutput.releaseWrite?.());
  await expect(dialog.getByRole("status", { name: "Batch progress" })).toHaveText(
    "2 of 2 files completed · 1 succeeded · 0 failed · 1 cancelled · Finished",
  );
  await expect(dialog.getByTestId("batch-file-0")).toContainText("Done");
  await expect(dialog.getByTestId("batch-file-1")).toContainText("Cancelled");
  expect(await page.evaluate(() => Object.keys(window.__aaeBatchOutput.files))).toEqual([
    "saved-processed.wav",
  ]);
  expect(await editorSnapshot(page)).toEqual(before);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const output = window.__aaeBatchOutput;
        return output.workersStarted - output.workersTerminated;
      }),
    )
    .toBe(1);
});

test("browsers without folder access deliver an actual downloadable processed file", async ({
  page,
}) => {
  await load(page);
  const before = await editorSnapshot(page);
  await page.evaluate(() => Object.assign(window, { showDirectoryPicker: undefined }));
  const dialog = await batchDialog(page, false);
  await dialog.getByRole("button", { name: "Use downloads", exact: true }).click();
  await dialog.getByLabel("Batch output format", { exact: true }).selectOption("wav");
  await dialog.getByLabel("Batch bit depth", { exact: true }).selectOption("16");
  await dialog.getByLabel("Batch audio files", { exact: true }).setInputFiles({
    name: "download.wav",
    mimeType: "audio/wav",
    buffer: fixture(),
  });
  const downloading = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Start batch", exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("download-processed.wav");
  const stream = await download.createReadStream();
  if (!stream) throw new Error("Batch download has no readable bytes");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const actual = Buffer.concat(chunks);
  const expected = await page.evaluate(async () => {
    const exported = (await window.__aaeTest?.request("doc.export", {
      format: "wav",
      bitDepth: 16,
      float: false,
      dither: "none",
    })) as ExportResult;
    return Array.from(new Uint8Array(exported.data));
  });
  expect(actual.equals(Buffer.from(expected))).toBe(true);
  await expect(dialog.getByRole("status", { name: "Batch progress" })).toHaveText(
    "1 of 1 files completed · 1 succeeded · 0 failed · 0 cancelled · Finished",
  );
  expect(await editorSnapshot(page)).toEqual(before);
});
