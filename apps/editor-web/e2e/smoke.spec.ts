import { expect, type Page, test } from "@playwright/test";

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
  expect(errors).toEqual([]);
});

test("plays the test tone through the worklet and stops cleanly", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  await expect(page.getByTestId("kernel-status")).toHaveText("kernel ready");

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

  await page.getByTestId("stop").click();
  await expect(page.getByTestId("play")).toBeEnabled();
  await expect(page.getByTestId("frames-played")).toHaveText("0");
  expect(errors).toEqual([]);
});
