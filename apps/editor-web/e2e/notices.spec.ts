/// <reference lib="dom" />
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test("About loads bundled notices on demand within a full HD viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/third-party-notices.txt")) requests.push(request.url());
  });
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
  await page.getByRole("button", { name: "Information", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "About / Status" });
  expect(requests).toEqual([]);
  await dialog.getByRole("button", { name: "Third-party notices" }).click();
  await expect(dialog.getByRole("textbox", { name: "Third-party license texts" })).toHaveValue(
    await readFile(new URL("../public/third-party-notices.txt", import.meta.url), "utf8"),
  );
  expect(requests).toHaveLength(1);
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds?.y).toBeGreaterThanOrEqual(0);
  expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(1080);
  await expect(dialog.getByRole("button", { name: "Close information" })).toBeInViewport();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Information", exact: true })).toBeFocused();
});
