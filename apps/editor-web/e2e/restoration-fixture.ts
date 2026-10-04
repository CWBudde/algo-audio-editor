import type { ProcessOperation } from "@aae/protocol";
import { expect, type Page } from "@playwright/test";
import { runCommand } from "./command-fixture.js";
import { info, load, samples, select } from "./edit-fixture.ts";

export function restorationTone(frames = 12000, hz = 440, amplitude = 0.4) {
  return Array.from({ length: frames }, (_, frame) =>
    Math.fround(amplitude * Math.sin((2 * Math.PI * hz * frame) / 48000)),
  );
}
export async function restorationCommand(page: Page, id: string, menu = "Restore") {
  await runCommand(page, id, menu);
}
export async function applyRestoration(
  page: Page,
  operation: ProcessOperation,
  fields: Record<string, string> = {},
) {
  const before = await info(page);
  await restorationCommand(
    page,
    `process.${operation}`,
    operation === "time-stretch" ? "Process" : "Restore",
  );
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  for (const [name, value] of Object.entries(fields))
    await dialog.getByLabel(name, { exact: true }).fill(value);
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(async () => (await info(page)).documentId).not.toBe(before.documentId);
  await expect(page.getByRole("alert")).toHaveCount(0);
}
export async function spectralClickRepair(page: Page) {
  const clean = restorationTone(24000),
    damaged = [...clean];
  for (let i = 12000; i < 12004; i++) damaged[i] += 0.8;
  await load(page, [damaged, clean]);
  const original = await samples(page);
  await select(page, 11998, 12006);
  await restorationCommand(page, "view.spectrogram", "View");
  await restorationCommand(page, "view.zoom-selection", "View");
  await page.getByLabel("Spectrogram selection tool").selectOption("rectangle");
  const layer = page.getByTestId("spectral-selection-0"),
    box = await layer.boundingBox();
  if (!box) throw new Error("Spectral selection surface missing");
  await page.mouse.move(box.x + box.width * 0.24, box.y + box.height * 0.1);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.76, box.y + box.height * 0.9);
  await page.mouse.up();
  await expect(page.getByRole("button", { name: "Heal…", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Heal…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Heal spectral selection" });
  await dialog.getByLabel("Lower frequency (Hz)").fill("0");
  await dialog.getByLabel("Upper frequency (Hz)").fill("24000");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const repaired = await samples(page);
  expect(repaired[1]).toEqual(original[1]);
  let energy = 0;
  for (let i = 0; i < clean.length; i++) energy += (repaired[0][i] - clean[i]) ** 2;
  expect(10 * Math.log10(energy / clean.length)).toBeLessThan(-80);
  await expect(page.getByTestId("spectral-selection-0")).not.toHaveAttribute("data-start-frame");
  await page.getByTestId("document-details").click();
  await page.keyboard.press("Control+z");
  await expect.poll(async () => await samples(page)).toEqual(original);
}
export async function stretchInShell(page: Page) {
  const left = restorationTone(),
    right = left.map((x) => x * -0.5);
  await load(page, [left, right]);
  await applyRestoration(page, "time-stretch", { "Duration multiplier": "1.5" });
  expect((await info(page)).frames).toBe(18000);
  const out = await samples(page);
  let crossings = 0;
  for (let i = 4001; i < 14000; i++) {
    if (out[0][i] >= 0 && out[0][i - 1] < 0) crossings++;
    expect(out[1][i]).toBe(out[0][i] * -0.5);
  }
  expect(Math.abs((crossings * 48000) / 9999 - 440)).toBeLessThan(6);
  await page.getByTestId("document-details").click();
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await info(page)).frames).toBe(12000);
  expect(await samples(page)).toEqual([left, right]);
}
