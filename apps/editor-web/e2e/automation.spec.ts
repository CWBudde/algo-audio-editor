/// <reference lib="dom" />
import { readFile, writeFile } from "node:fs/promises";
import type { ExportResult } from "@aae/protocol";
import { expect, type Page, test } from "@playwright/test";
import { fixture, info, LEFT, load, RIGHT, samples, select } from "./edit-fixture.ts";
import { showEffectMenuItem } from "./effect-menu.ts";
import { captureKernelWorker } from "./kernel-probe.ts";

async function command(page: Page, menu: string, id: string) {
  await page.getByRole("menuitem", { name: menu, exact: true }).click();
  await page.locator(`[role="menuitem"][data-command-id="${id}"]`).click();
}
async function automation(page: Page) {
  await command(page, "File", "file.automation");
  const dialog = page.getByRole("dialog", { name: "Macros and automation" });
  await expect(dialog).toBeVisible();
  return dialog;
}
test.beforeEach(async ({ page, context }) => {
  await captureKernelWorker(context);
  await page.addInitScript(() => Object.assign(window, { showSaveFilePicker: undefined }));
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
});
test("records successful processing once, replays exact output, exports a CLI chain and restores undo", async ({
  page,
}, testInfo) => {
  await load(page);
  await command(page, "File", "file.record-macro");
  await expect(page.getByRole("button", { name: "Recording macro · Stop" })).toBeVisible();
  await command(page, "Process", "process.amplify");
  const process = page.getByRole("dialog", { name: "Amplify" });
  await process.getByLabel("Gain (dB)").fill("-6.020599913279624");
  await process.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(process.getByRole("button", { name: "Stop preview", exact: true })).toBeVisible();
  await process.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(process).not.toBeVisible();
  await command(page, "Process", "process.reverse");
  const reverse = page.locator("dialog[open]");
  await reverse.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(reverse).not.toBeVisible();
  const expected = [LEFT, RIGHT].map((channel) => channel.map((sample) => sample * 0.5).reverse());
  expect(await samples(page)).toEqual(expected);
  await page.getByRole("button", { name: "Recording macro · Stop" }).click();
  let dialog = await automation(page);
  await expect(dialog.getByRole("status")).toHaveText("2 operations");
  const downloading = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Export chain" }).click();
  const download = await downloading;
  const path = testInfo.outputPath("macro.json");
  await download.saveAs(path);
  const chain = JSON.parse(await readFile(path, "utf8"));
  expect(chain).toEqual({
    version: 1,
    operations: [
      {
        method: "process.start",
        range: "document",
        params: { operation: "gain", gainDb: -6.020599913279624 },
      },
      { method: "process.start", range: "document", params: { operation: "reverse" } },
    ],
  });
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await load(page);
  dialog = await automation(page);
  await dialog.getByRole("button", { name: "Apply macro" }).click();
  await expect(dialog.getByRole("status")).toContainText("2 of 2 completed");
  expect(await samples(page)).toEqual(expected);
  await page.keyboard.press("Control+z");
  expect(await samples(page)).toEqual(expected);
  const exported = await page.evaluate(async () => {
    const result = (await window.__aaeTest?.request("doc.export", {
      format: "wav",
      bitDepth: 32,
      float: true,
    })) as ExportResult;
    return Array.from(new Uint8Array(result.data));
  });
  await writeFile(testInfo.outputPath("source.wav"), fixture());
  await writeFile(testInfo.outputPath("browser.wav"), Buffer.from(exported));
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByTestId("document-details").click();
  await page.keyboard.press("Control+z");
  await expect
    .poll(() => samples(page))
    .toEqual([LEFT, RIGHT].map((channel) => channel.map((sample) => sample * 0.5)));
  await page.keyboard.press("Control+z");
  await expect.poll(() => samples(page)).toEqual([LEFT, RIGHT]);
});
test("imports a chain, follows crop identity, applies the new whole range and keeps a failed prefix undoable", async ({
  page,
}) => {
  await load(page);
  const dialog = await automation(page);
  await dialog.getByLabel("Import chain", { exact: true }).setInputFiles({
    name: "chain.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        version: 1,
        operations: [
          { method: "edit.apply", params: { operation: "crop", start: 2, end: 6 } },
          { method: "process.start", range: "document", params: { operation: "reverse" } },
          {
            method: "process.start",
            range: "document",
            params: { operation: "gain", gainDb: 200 },
          },
        ],
      }),
    ),
  });
  await expect(dialog.getByRole("status")).toHaveText("3 operations");
  await dialog.getByRole("button", { name: "Apply macro" }).click();
  await expect(dialog.getByRole("alert")).toContainText("after 2 of 3 operations");
  expect((await info(page)).frames).toBe(4);
  expect(await samples(page)).toEqual(
    [LEFT, RIGHT].map((channel) => channel.slice(2, 6).reverse()),
  );
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByTestId("document-details").click();
  await page.keyboard.press("Control+z");
  await expect
    .poll(() => samples(page))
    .toEqual([LEFT, RIGHT].map((channel) => channel.slice(2, 6)));
  await page.keyboard.press("Control+z");
  await expect.poll(() => samples(page)).toEqual([LEFT, RIGHT]);
});
test("records clipboard edits and replays with a fresh clipboard version", async ({ page }) => {
  await load(page);
  await select(page, 1, 3);
  await command(page, "File", "file.record-macro");
  await command(page, "Edit", "edit.copy");
  await command(page, "Edit", "edit.paste-insert");
  await expect.poll(async () => (await info(page)).frames).toBe(10);
  const expected = await samples(page);
  await page.getByRole("button", { name: "Recording macro · Stop" }).click();
  await load(page);
  const dialog = await automation(page);
  await expect(dialog.getByRole("status")).toHaveText("2 operations");
  await dialog.getByRole("button", { name: "Apply macro" }).click();
  await expect(dialog.getByRole("status")).toContainText("2 of 2 completed");
  expect(await samples(page)).toEqual(expected);
});

test("records an effect graph and reproduces its exact output on a fresh document", async ({
  page,
}) => {
  await load(page);
  await command(page, "File", "file.record-macro");
  await (await showEffectMenuItem(page, "ringmod")).click();
  const effects = page.getByRole("dialog", { name: "Effects rack" });
  await expect(effects.getByTestId("effects-status")).toHaveText("Ready");
  await effects.getByRole("button", { name: "Apply rack", exact: true }).click();
  await expect(effects).not.toBeVisible();
  const expected = await samples(page);
  expect(expected).not.toEqual([LEFT, RIGHT]);
  await page.getByRole("button", { name: "Recording macro · Stop" }).click();
  await load(page);
  const dialog = await automation(page);
  await expect(dialog.getByRole("status")).toHaveText("1 operation");
  await dialog.getByRole("button", { name: "Apply macro" }).click();
  await expect(dialog.getByRole("status")).toContainText("1 of 1 completed");
  expect(await samples(page)).toEqual(expected);
});

test("macro copy publishes clipboard availability to the editor commands", async ({ page }) => {
  await load(page);
  const dialog = await automation(page);
  await dialog.getByLabel("Import chain", { exact: true }).setInputFiles({
    name: "copy.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        version: 1,
        operations: [{ method: "edit.apply", range: "document", params: { operation: "copy" } }],
      }),
    ),
  });
  await expect(dialog.getByRole("status")).toHaveText("1 operation");
  await dialog.getByRole("button", { name: "Apply macro" }).click();
  await expect(dialog.getByRole("status")).toContainText("1 of 1 completed");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  await expect(
    page.locator('[role="menuitem"][data-command-id="edit.paste-insert"]'),
  ).not.toHaveAttribute("aria-disabled", "true");
});
