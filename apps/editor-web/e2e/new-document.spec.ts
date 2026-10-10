import { expect, type Page, test } from "@playwright/test";
import { edit, load, select } from "./edit-fixture.ts";
import { captureKernelWorker } from "./kernel-probe.ts";

test.beforeEach(async ({ page }) => {
  await captureKernelWorker(page);
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
});

async function newDocument(page: Page) {
  await page.getByRole("menuitem", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "New…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New document" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("File → New creates clean silence in the chosen format", async ({ page }) => {
  const dialog = await newDocument(page);
  await expect(dialog.getByLabel("Sample rate")).toBeFocused();
  await dialog.getByLabel("Sample rate").selectOption("44100");
  await dialog.getByLabel("Channels").selectOption("1");
  await dialog.getByLabel("Length (seconds)").fill("2");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByTestId("document-name")).toHaveText("Untitled");
  await expect(page.getByTestId("document-details")).toContainText(
    "44100 Hz · 1 channel · 88200 frames · 2.000 s · 32-bit float",
  );
  await expect(page.getByTestId("document-save-status")).toHaveText("Saved");
  await expect(page).toHaveTitle(/^Untitled — /);

  // An empty document is valid too, and replacing a clean one needs no prompt.
  page.on("dialog", (prompt) => {
    throw new Error(`unexpected ${prompt.type()} dialog`);
  });
  const empty = await newDocument(page);
  await empty.getByRole("button", { name: "Create" }).click();
  await expect(page.getByTestId("document-details")).toContainText(
    "48000 Hz · 2 channels · 0 frames",
  );
});

test("File → New asks before replacing unsaved changes", async ({ page }) => {
  await load(page);
  await select(page, 2, 6);
  await edit(page, "Mute", 8);
  await expect(page.getByTestId("document-save-status")).toHaveText("Unsaved changes");
  const name = await page.getByTestId("document-name").textContent();

  let dialog = await newDocument(page);
  let prompt = page.waitForEvent("dialog");
  await dialog.getByRole("button", { name: "Create" }).click();
  const declined = await prompt;
  expect(declined.message()).toContain(`Discard changes to ${name}?`);
  await declined.dismiss();
  await expect(page.getByTestId("document-save-status")).toHaveText("Unsaved changes");
  await expect(page.getByTestId("document-name")).toHaveText(name ?? "");

  dialog = await newDocument(page);
  prompt = page.waitForEvent("dialog");
  await dialog.getByRole("button", { name: "Create" }).click();
  await (await prompt).accept();
  await expect(page.getByTestId("document-name")).toHaveText("Untitled");
  await expect(page.getByTestId("document-save-status")).toHaveText("Saved");
});
