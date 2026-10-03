/// <reference lib="dom" />
import { expect, type Page, test } from "@playwright/test";
import { PROTOCOL_VERSION } from "../../../packages/protocol/src/index.ts";
import { playbackWAV } from "./playback-fixture.js";

type ProbeReply =
  | { kind: "reply"; id: number; ok: true; result: unknown }
  | { kind: "reply"; id: number; ok: false; error: string }
  | { kind: "fatal"; error: string };

/** Collects console errors and uncaught exceptions for the whole test. */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

test("boots the kernel in a cross-origin isolated page", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");

  await expect(page.getByTestId("kernel-status")).toHaveText("kernel ready");
  await expect(page.getByTestId("kernel-version")).toContainText("go1.");
  await expect(page.getByTestId("document-memory")).toHaveText("0 B");
  await expect(page.getByTestId("cross-origin-isolated")).toHaveText("yes");
  await expect(page.getByTestId("platform")).toHaveText("Browser");
  await page.getByRole("menuitem", { name: "Help", exact: true }).click();
  await page.getByRole("menuitem", { name: "About", exact: true }).click();
  await expect(page.getByText(`ABI v${PROTOCOL_VERSION}`, { exact: false })).toBeVisible();
  expect(errors).toEqual([]);
});

test("routes peak requests to the actual WASM kernel", async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const workers: Worker[] = [];
    Object.assign(window, { __aaeTestWorkers: workers });
    window.Worker = class extends NativeWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        if (options?.name === "aae-kernel") workers.push(this);
      }
    };
  });
  await page.goto("/");
  await expect(page.getByTestId("kernel-status")).toHaveText("kernel ready");

  const reply = await page.evaluate(async () => {
    const workers = (window as Window & { __aaeTestWorkers?: Worker[] }).__aaeTestWorkers;
    const createdWorker = workers?.[0];
    if (!createdWorker) throw new Error("kernel worker was not created");
    const worker = createdWorker;
    // Client IDs are positive; this read-only probe cannot consume a pending
    // application response. It uses the same production worker and Go bridge.
    const request = {
      id: -1,
      op: "call",
      method: "peaks.get",
      params: { channel: 0, startFrame: 0, endFrame: 1, buckets: 1 },
    };
    return new Promise<ProbeReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.removeEventListener("message", onMessage);
        reject(new Error("peak probe timed out"));
      }, 5_000);
      function onMessage(event: MessageEvent<ProbeReply>) {
        if (event.data.kind !== "reply" || event.data.id !== request.id) return;
        clearTimeout(timer);
        worker.removeEventListener("message", onMessage);
        resolve(event.data);
      }
      worker.addEventListener("message", onMessage);
      worker.postMessage(request);
    });
  });
  expect(reply).toMatchObject({ kind: "reply", id: -1, ok: false });
  if (reply.kind !== "reply" || reply.ok) throw new Error("expected no-document rejection");
  expect(reply.error).toMatch(/peaks.get:.*no (active )?document/);
  await expect(page.getByTestId("document-memory")).toHaveText("0 B");
  expect(errors).toEqual([]);
});

test("plays the loaded document through the worklet and stops cleanly", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  await expect(page.getByTestId("kernel-status")).toHaveText("kernel ready");

  await expect(page.getByTestId("play")).toBeDisabled();
  await page.getByTestId("audio-file-input").setInputFiles({
    name: "playback.wav",
    mimeType: "audio/wav",
    buffer: playbackWAV(),
  });
  await expect(page.getByTestId("document-name")).toHaveText("playback.wav");

  await page.getByTestId("play").click();

  // The worklet only advances the consumed-frames counter while the audio
  // thread is actually pulling from the ring the kernel worker fills.
  await expect
    .poll(async () => Number(await page.getByTestId("frames-played").textContent()), {
      timeout: 10_000,
    })
    .toBeGreaterThan(48_000);
  // The ring is primed before the context resumes, so playback starts without
  // a single starved frame.
  await expect(page.getByTestId("underruns")).toHaveText("0");
  await expect
    .poll(async () => Number(await page.getByTestId("play-position").getAttribute("data-frame")))
    .toBeGreaterThan(48000);

  await page.getByTestId("stop").click();
  await expect(page.getByTestId("play")).toBeEnabled();
  await expect(page.getByTestId("frames-played")).toHaveText("0");
  expect(errors).toEqual([]);
});
