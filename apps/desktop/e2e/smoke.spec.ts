import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("loads the editor over app:// with cross-origin isolation", async () => {
  const app = await electron.launch({
    args: [path.join(__dirname, ".."), "--autoplay-policy=no-user-gesture-required"],
  });
  try {
    const page = await app.firstWindow();
    // Console errors catch what pageerror misses: CSP violations and a
    // preload script that failed to load.
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    expect(page.url()).toBe("app://editor/index.html");
    await expect(page.getByTestId("kernel-status")).toHaveText("kernel ready");
    await expect(page.getByTestId("cross-origin-isolated")).toHaveText("yes");
    await expect(page.getByTestId("platform")).toContainText("Electron");

    await page.getByTestId("play").click();
    await expect
      .poll(async () => Number(await page.getByTestId("frames-played").textContent()))
      .toBeGreaterThan(48_000);
    await page.getByTestId("stop").click();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
