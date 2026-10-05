/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import { downloadedBytes, wavChunk } from "./export-fixture.ts";
import { playbackWAV } from "./playback-fixture.ts";

test("cold Pages visit isolates, imports, plays and exports unchanged audio", async ({
  page,
  baseURL,
}) => {
  const errors: string[] = [];
  const failedAssets: string[] = [];
  const assets = new Set<string>();
  let navigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (/\.(wasm|js|css)$/.test(url.pathname)) {
      assets.add(url.pathname);
      if (!response.ok()) failedAssets.push(`${response.status()} ${url.pathname}`);
    }
  });
  await page.addInitScript(() => Object.assign(window, { showSaveFilePicker: undefined }));
  await page.goto("./");
  await expect.poll(() => page.evaluate(() => crossOriginIsolated)).toBe(true);
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
  expect(await page.evaluate(() => typeof SharedArrayBuffer)).toBe("function");
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toBe(baseURL);
  expect(navigations).toBe(2);

  if (process.env.AAE_EXPECTED_COMMIT) {
    await page.getByRole("menuitem", { name: "Help", exact: true }).click();
    await page.getByRole("menuitem", { name: "About", exact: true }).click();
    await expect(page.getByTestId("build-commit")).toHaveText(process.env.AAE_EXPECTED_COMMIT);
    await expect(page.getByTestId("build-time")).not.toHaveText("–");
    await page.keyboard.press("Escape");
  }
  const source = playbackWAV();
  await page
    .getByTestId("audio-file-input")
    .setInputFiles({ name: "pages-smoke.wav", mimeType: "audio/wav", buffer: source });
  await expect(page.getByTestId("document-name")).toHaveText("pages-smoke.wav");
  await page.getByTestId("play").click();
  await expect
    .poll(async () => Number(await page.getByTestId("frames-played").textContent()))
    .toBeGreaterThan(48_000);
  await expect(page.getByTestId("underruns")).toHaveText("0");
  await page.getByTestId("stop").click();
  const download = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Save\b/ }).click();
  const output = await downloadedBytes(await download);
  expect(wavChunk(output, "data")).toEqual(wavChunk(source, "data"));
  const prefix = new URL(baseURL ?? "").pathname;
  expect([...assets].every((asset) => asset.startsWith(prefix))).toBe(true);
  // Playback above exercises AudioWorklet.addModule, whose response is not
  // reported as a page response by Chromium's automation API.
  expect(failedAssets).toEqual([]);
  expect(errors).toEqual([]);
});

test("bundled demo opens with one click and a warm visit needs no isolation reload", async ({
  page,
}) => {
  await page.goto("./");
  await expect.poll(() => page.evaluate(() => crossOriginIsolated)).toBe(true);
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
  await expect(page.getByText("files are never uploaded.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Open demo", exact: true }).click();
  await expect(page.getByTestId("document-name")).toHaveText("demo.wav");
  await expect(page.getByTestId("document-details")).toContainText(
    "48000 Hz · 2 channels · 192000 frames",
  );
  await page.screenshot({ path: test.info().outputPath("editor-demo.png") });
  let navigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  const response = await page.reload();
  expect(response?.headers()["cache-control"]).toBe("no-store");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  expect(navigations).toBe(1);
  await expect(page.getByRole("button", { name: "Open demo", exact: true })).toBeEnabled();
});

test("deep links render the editor through 404.html", async ({ page }) => {
  await page.goto("./shared/example");
  await expect.poll(() => page.evaluate(() => crossOriginIsolated)).toBe(true);
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
  await expect(page.getByRole("button", { name: "Open demo", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Information", exact: true }).click();
  const noticeResponse = page.waitForResponse((response) =>
    response.url().endsWith("/algo-audio-editor/third-party-notices.txt"),
  );
  await page.getByRole("button", { name: "Third-party notices", exact: true }).click();
  expect((await noticeResponse).ok()).toBe(true);
  await expect(page.getByRole("textbox", { name: "Third-party license texts" })).toHaveValue(
    /Permission is hereby granted/,
  );
});

test.describe("blocked service workers", () => {
  test.use({ serviceWorkers: "block" });
  test("shows actionable isolation guidance without a reload loop", async ({ page }) => {
    let navigations = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations++;
    });
    await page.goto("./");
    await expect(
      page.getByRole("alert").filter({ hasText: "Allow service workers" }),
    ).toBeVisible();
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);
    await expect(
      page.getByTestId("document-drop-zone").getByText("No document open", { exact: true }),
    ).toBeVisible();
    expect(navigations).toBe(1);
  });
});
