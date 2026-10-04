import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { fixture, LEFT, load, RIGHT, samples, select } from "../../editor-web/e2e/edit-fixture.js";
import { showEffectMenuItem } from "../../editor-web/e2e/effect-menu.js";
import { sourceState } from "../../editor-web/e2e/export-fixture.js";
import { captureKernelWorker } from "../../editor-web/e2e/kernel-probe.js";
import type { DesktopBridge } from "../../editor-web/src/platform.js";

test("Electron effects rack preview, one-step apply and durable IR presets use the secure userData bridge", async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(path.join(tmpdir(), "aae-effect-presets-"));
  const app = await electron.launch({
    args: [path.join(__dirname, ".."), "--autoplay-policy=no-user-gesture-required"],
  });
  try {
    await app.evaluate(({ app }, directory) => app.setPath("userData", directory), directory);
    const page = await app.firstWindow();
    await captureKernelWorker(page);
    await page.reload();
    await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
    await load(page);
    await select(page, 2, 6);
    const before = await sourceState(page);
    const open = async (id: string) => {
      await (await showEffectMenuItem(page, id)).click();
      const dialog = page.getByRole("dialog", { name: "Effects rack" });
      await expect(dialog.getByTestId("effects-status")).toHaveText("Ready");
      return dialog;
    };
    let dialog = await open("distortion");
    await dialog.getByLabel("Output", { exact: true }).fill("0");
    await dialog.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(dialog.getByTestId("effects-status")).toHaveText("Previewing live effects");
    expect(await sourceState(page)).toEqual(before);
    await dialog.getByRole("button", { name: "Apply rack", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(await samples(page)).toEqual([
      LEFT.map((value, index) => (index >= 2 && index < 6 ? value * 0 : value)),
      RIGHT.map((value, index) => (index >= 2 && index < 6 ? value * 0 : value)),
    ]);
    expect((await sourceState(page)).history.entries).toHaveLength(
      before.history.entries.length + 1,
    );
    await page.getByTestId("document-details").click();
    await page.keyboard.press("Control+z");
    await expect.poll(() => samples(page)).toEqual([LEFT, RIGHT]);
    dialog = await open("reverb-conv");
    const impulse = fixture([[1]], 48000);
    await dialog
      .getByLabel("Impulse response WAV", { exact: true })
      .setInputFiles({ name: "desktop-room.wav", mimeType: "audio/wav", buffer: impulse });
    await expect(dialog.getByRole("button", { name: "Preview", exact: true })).toBeEnabled();
    await dialog.getByLabel("Preset name", { exact: true }).fill("Desktop room");
    await dialog.getByRole("button", { name: "Save preset", exact: true }).click();
    await expect(
      dialog
        .getByLabel("User preset", { exact: true })
        .getByRole("option", { name: "Desktop room", exact: true }),
    ).toHaveCount(1);
    const stored = JSON.parse(
      await readFile(path.join(directory, "effect-presets.json"), "utf8"),
    ) as {
      version: number;
      presets: { name: string; rack: { irAssetId: string; params: Record<string, unknown> }[] }[];
    };
    expect(stored.version).toBe(1);
    expect(stored.presets[0].name).toBe("Desktop room");
    expect(stored.presets[0].rack[0].params.irIndex).toBeUndefined();
    expect(
      await readFile(
        path.join(directory, "effect-impulses", `${stored.presets[0].rack[0].irAssetId}.wav`),
      ),
    ).toEqual(impulse);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.reload();
    await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
    await load(page);
    dialog = await open("rack");
    await dialog.getByLabel("User preset", { exact: true }).selectOption({ label: "Desktop room" });
    await expect(dialog).toContainText("desktop-room.wav");
    await expect(dialog.getByRole("button", { name: "Preview", exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(dialog.getByTestId("effects-status")).toHaveText("Previewing live effects");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(
      page.evaluate(async () => {
        try {
          await (window as Window & { aaeDesktop?: DesktopBridge }).aaeDesktop?.loadEffectIR?.(
            "../../escape",
          );
          return false;
        } catch {
          return true;
        }
      }),
    ).resolves.toBe(true);
    dialog = await open("reverb-conv");
    await dialog
      .getByLabel("Impulse response WAV", { exact: true })
      .setInputFiles({ name: "unsaved.wav", mimeType: "audio/wav", buffer: impulse });
    await expect(dialog.getByRole("button", { name: "Preview", exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(
      (await readdir(path.join(directory, "effect-impulses"))).filter((file) =>
        file.endsWith(".wav"),
      ),
    ).toHaveLength(1);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
