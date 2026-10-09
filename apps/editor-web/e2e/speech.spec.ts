/// <reference lib="dom" />
import type { HistoryListResult } from "@aae/protocol";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { info, LEFT, load, RIGHT, samples, select } from "./edit-fixture.ts";
import { captureKernelWorker } from "./kernel-probe.ts";
import { installSpeechStub, STUB_SPEECH_SAMPLES, speechRequests } from "./speech-stub.ts";

/** 24 kHz stub speech placed in a 48 kHz document. */
const PLACED = STUB_SPEECH_SAMPLES * 2;

async function history(page: Page) {
  const document = await info(page);
  return page.evaluate(
    async (documentId) =>
      (await window.__aaeTest?.request("history.list", { documentId })) as HistoryListResult,
    document.documentId,
  );
}

async function command(page: Page, menu: string, id: string) {
  await page.getByRole("menuitem", { name: menu, exact: true }).click();
  await page.locator(`[role="menuitem"][data-command-id="${id}"]`).click();
}

async function openSpeech(page: Page) {
  await command(page, "Process", "process.generate-speech");
  const dialog = page.getByRole("dialog", { name: "Generate speech" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Model")).toBeEnabled();
  return dialog;
}

async function generate(dialog: Locator, text: string) {
  await dialog.getByLabel("Text").fill(text);
  await dialog.getByRole("button", { name: "Generate", exact: true }).click();
}

test.beforeEach(async ({ page, context }) => {
  await captureKernelWorker(context);
  await installSpeechStub(page);
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
});

test("generates speech, previews it, applies one edit at the cursor and undoes it", async ({
  page,
}) => {
  await load(page);
  await select(page, 4, 4);
  const before = await history(page);
  const dialog = await openSpeech(page);
  await expect(dialog.getByTestId("speech-placement")).toHaveText(
    "Inserts at 0:00.000 (both channels)",
  );
  await expect(dialog.getByLabel("Voice")).toHaveValue("alba");
  await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  await generate(dialog, "Hello from the editor.");
  await expect(dialog.getByTestId("speech-status")).toHaveText("Speech ready");
  expect(await history(page)).toEqual(before);
  await dialog.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(dialog.getByTestId("speech-status")).toHaveText("Previewing generated speech");
  await dialog.getByRole("button", { name: "Stop preview", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Preview", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(async () => (await info(page)).frames).toBe(8 + PLACED);
  const after = await history(page);
  expect(after.entries.length).toBe(before.entries.length + 1);
  const output = await samples(page);
  expect(output[0].slice(0, 4)).toEqual(LEFT.slice(0, 4));
  expect(output[0].slice(4 + PLACED)).toEqual(LEFT.slice(4));
  expect(output[1].slice(4 + PLACED)).toEqual(RIGHT.slice(4));
  // The mono speech is written to both selected channels and keeps its level mid-way.
  expect(output[0][4 + PLACED / 2]).toBeCloseTo(0.25, 3);
  expect(output[1].slice(4, 4 + PLACED)).toEqual(output[0].slice(4, 4 + PLACED));
  const requests = await speechRequests(page);
  expect(requests.filter((request) => request.op === "ensure")).toHaveLength(1);
  const synthesis = requests.find((request) => request.op === "synthesize");
  expect(synthesis?.params).toMatchObject({
    model: "english_2026-01",
    voice: "alba",
    text: "Hello from the editor.",
    temperature: 0.3,
    samplerSteps: 1,
    eosThreshold: -4,
  });
  await page.getByTestId("document-details").click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => samples(page)).toEqual([LEFT, RIGHT]);
});

test("replaces a channel selection and creates audio in an empty document", async ({ page }) => {
  await load(page, [[], []]);
  let dialog = await openSpeech(page);
  await expect(dialog.getByTestId("speech-placement")).toHaveText(
    "Creates audio in the empty document",
  );
  await generate(dialog, "First words.");
  await expect(dialog.getByTestId("speech-status")).toHaveText("Speech ready");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(async () => (await info(page)).frames).toBe(PLACED);

  await select(page, 0, PLACED);
  dialog = await openSpeech(page);
  await expect(dialog.getByTestId("speech-placement")).toHaveText(/^Replaces 0:00\.000–0:00\.100/);
  // A second Generate with the same model loads nothing again.
  await generate(dialog, "Second words.");
  await expect(dialog.getByTestId("speech-status")).toHaveText("Speech ready");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect((await info(page)).frames).toBe(PLACED);
  expect((await speechRequests(page)).filter((request) => request.op === "ensure")).toHaveLength(1);
});

test("Cancel stops a running synthesis and leaves the document unchanged", async ({ page }) => {
  await load(page);
  const before = await history(page);
  const dialog = await openSpeech(page);
  await generate(dialog, "Please wait for this.");
  await expect(dialog.getByTestId("speech-status")).toHaveText("Sentence 1 of 2");
  await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect((await speechRequests(page)).some((request) => request.op === "cancel")).toBe(true);
  expect(await history(page)).toEqual(before);
  expect(await samples(page)).toEqual([LEFT, RIGHT]);
  // The editor is usable again, and so is the speech dialog.
  const reopened = await openSpeech(page);
  await expect(reopened.getByTestId("speech-status")).toHaveText("Ready to generate");
  await reopened.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(reopened).not.toBeVisible();
});

test("shows a failed synthesis inline and Retry generates again", async ({ page }) => {
  await load(page);
  const dialog = await openSpeech(page);
  await generate(dialog, "This will fail.");
  await expect(dialog.getByRole("alert")).toContainText("speech: synthetic failure");
  await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  await dialog.getByLabel("Text").fill("This works.");
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(dialog.getByTestId("speech-status")).toHaveText("Speech ready");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  // Editing after Generate invalidates the candidate until the next Generate.
  await dialog.getByLabel("Text").fill("Something else.");
  await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).not.toBeVisible();
});

test("records speech.generate in a macro and replays it by synthesizing again", async ({
  page,
}) => {
  await load(page);
  await select(page, 8, 8);
  await command(page, "File", "file.record-macro");
  await expect(page.getByRole("button", { name: "Recording macro · Stop" })).toBeVisible();
  const dialog = await openSpeech(page);
  await dialog.getByText("Advanced").click();
  await dialog.getByLabel("Seed").fill("1234");
  await generate(dialog, "Recorded speech.");
  await expect(dialog.getByTestId("speech-status")).toHaveText("Speech ready");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "Recording macro · Stop" }).click();
  await command(page, "File", "file.automation");
  const automation = page.getByRole("dialog", { name: "Macros and automation" });
  await expect(automation.getByRole("status")).toHaveText("1 operation");
  await expect(automation.getByRole("listitem")).toHaveText(/^Speech ·/);
  await automation.getByRole("button", { name: "Close", exact: true }).click();

  await load(page);
  await select(page, 8, 8);
  await command(page, "File", "file.automation");
  await automation.getByRole("button", { name: "Apply macro" }).click();
  await expect(automation.getByRole("status")).toContainText("1 of 1 completed");
  expect((await info(page)).frames).toBe(8 + PLACED);
  const syntheses = (await speechRequests(page)).filter((request) => request.op === "synthesize");
  expect(syntheses).toHaveLength(2);
  expect(syntheses[1].params).toEqual({ ...(syntheses[0].params as object) });
  expect(syntheses[1].params).toMatchObject({ seed: 1234, text: "Recorded speech." });
});
