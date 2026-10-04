/// <reference lib="dom" />
import type { EffectDescriptor } from "@aae/protocol";
import { expect, type Page, test } from "@playwright/test";
import { fixture, LEFT, load, RIGHT, samples, select } from "./edit-fixture.ts";
import { showEffectMenuItem } from "./effect-menu.ts";
import { sourceState } from "./export-fixture.ts";
import { captureKernelWorker } from "./kernel-probe.ts";
import { revealControl } from "./ui-disclosures.ts";

async function catalogue(page: Page) {
  return page.evaluate(
    async () =>
      (await window.__aaeTest?.request("effects.list", { sampleRate: 48000 })) as {
        effects: EffectDescriptor[];
      },
  );
}
async function openEffect(page: Page, id = "rack") {
  await (await showEffectMenuItem(page, id)).click();
  const dialog = page.getByRole("dialog", { name: "Effects rack" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("effects-status")).toHaveText("Ready");
  return dialog;
}
async function apply(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Effects rack" });
  await dialog.getByRole("button", { name: "Apply rack", exact: true }).click();
  await expect
    .poll(async () => {
      const [status] = await dialog.getByTestId("effects-status").allTextContents();
      return status === undefined
        ? "closed"
        : status === "Review output levels"
          ? "warning"
          : "working";
    })
    .not.toBe("working");
  if (await dialog.isVisible())
    await dialog.getByRole("button", { name: "Apply anyway", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}
test.beforeEach(async ({ page }) => {
  await captureKernelWorker(page);
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
});
test("Effects presents compact categories with keyboard access to effect commands", async ({
  page,
}) => {
  await load(page);
  await page.getByRole("menuitem", { name: "Effects", exact: true }).click();
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText([
    "Effect rack…",
    "Filters",
    "Dynamics",
    "Modulation",
    "Time/Space",
    "Pitch",
    "Spatial",
    "Color",
    "Routing",
  ]);
  const color = page.getByRole("menuitem", { name: "Color", exact: true });
  await color.focus();
  await page.keyboard.press("ArrowRight");
  const distortion = page.locator('[role="menuitem"][data-command-id="effects.distortion"]');
  await expect(distortion).toBeVisible();
  await distortion.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Effects rack" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Effects rack" })).not.toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Effects", exact: true })).toBeFocused();
});

test("every default registry effect has accessible real controls, live preview and one undoable apply", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { effects } = await catalogue(page);
  expect(effects.length).toBeGreaterThanOrEqual(50);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const descriptor of effects)
    await test.step(descriptor.name, async () => {
      const pitch = descriptor.id.startsWith("pitch-");
      const source = Array.from({ length: pitch ? 96000 : 512 }, (_, index) =>
        pitch
          ? Math.fround(0.25 * Math.sin((2 * Math.PI * 1000 * index) / 48000))
          : ((index % 32) - 16) / 64,
      );
      await load(page, [source, source]);
      const before = await sourceState(page);
      const dialog = await openEffect(page, descriptor.id);
      await expect(dialog.locator(`[data-effect-id="${descriptor.id}"]`)).toBeVisible();
      if (descriptor.view !== "generic")
        await expect(
          dialog
            .getByRole("img", { name: `${descriptor.name} response curve`, exact: true })
            .locator("path[data-testid=effect-response-path]"),
        ).toHaveAttribute("d", /^M\S+/);
      if (descriptor.id === "reverb-conv") {
        await expect(dialog.getByRole("alert")).toHaveText(
          "Complete the required parameters and impulse response before preview or apply.",
        );
        await expect(dialog.getByRole("button", { name: "Preview", exact: true })).toBeDisabled();
        await expect(
          dialog.getByRole("button", { name: "Apply rack", exact: true }),
        ).toBeDisabled();
        await dialog.getByLabel("Impulse response WAV", { exact: true }).setInputFiles({
          name: "unit-impulse.wav",
          mimeType: "audio/wav",
          buffer: fixture([[1]], 48000),
        });
      }
      await expect(dialog.getByRole("alert")).toHaveCount(0);
      if (pitch) await dialog.getByLabel("Semitones", { exact: true }).fill("12");
      await expect(dialog.getByRole("button", { name: "Preview", exact: true })).toBeEnabled();
      await dialog.getByRole("button", { name: "Preview", exact: true }).click();
      await expect(dialog.getByTestId("effects-status")).toHaveText("Previewing live effects");
      expect(await sourceState(page)).toEqual(before);
      await dialog.getByRole("button", { name: "Stop preview", exact: true }).click();
      await expect(dialog.getByTestId("effects-status")).toHaveText("Ready");
      await apply(page);
      const after = await sourceState(page);
      expect(after.document).toMatchObject({
        sampleRate: 48000,
        channels: 2,
        frames: source.length,
      });
      expect(after.history.entries).toHaveLength(before.history.entries.length + 1);
      const rendered = (await samples(page)).flat();
      expect(rendered.every(Number.isFinite)).toBe(true);
      if (pitch) expect(rendered.some((sample) => Math.abs(sample) > 0.001)).toBe(true);
      await page.getByTestId("document-details").click();
      await page.keyboard.press("Control+z");
      await expect.poll(() => samples(page)).toEqual([source, source]);
    });
  expect(errors).toEqual([]);
});
test("rack reordering, selected channels and wet/bypass preserve source until one final commit", async ({
  page,
}) => {
  await load(page);
  await select(page, 2, 6);
  await (
    await revealControl(
      page.getByRole("button", { name: "Right", exact: true, includeHidden: true }),
    )
  ).click();
  const before = await sourceState(page);
  const dialog = await openEffect(page, "distortion");
  await dialog.getByLabel("Mode", { exact: true }).selectOption("hardclip");
  await dialog.getByLabel("Output", { exact: true }).fill("0");
  await dialog.getByLabel("Add effect", { exact: true }).selectOption("bitcrusher");
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await dialog.getByRole("button", { name: "Move Bitcrusher up", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "1. Bitcrusher", exact: true })).toBeVisible();
  await dialog.getByLabel("Bypass Bitcrusher", { exact: true }).check();
  await dialog.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(dialog.getByTestId("effects-status")).toHaveText("Previewing live effects");
  await expect(dialog.getByLabel("Input and output meters")).toBeVisible();
  await dialog.getByRole("slider", { name: "Wet/dry", exact: true }).press("Home");
  await dialog.getByRole("slider", { name: "Wet/dry", exact: true }).press("ArrowRight");
  await dialog.getByLabel("Bypass rack", { exact: true }).check();
  await dialog.getByLabel("Bypass rack", { exact: true }).uncheck();
  expect(await sourceState(page)).toEqual(before);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(await sourceState(page)).toEqual(before);
  const reopened = await openEffect(page, "distortion");
  await reopened.getByLabel("Output", { exact: true }).fill("0");
  await apply(page);
  expect(await samples(page)).toEqual([
    LEFT,
    RIGHT.map((value, index) => (index >= 2 && index < 6 ? value * 0 : value)),
  ]);
  expect((await sourceState(page)).history.entries).toHaveLength(before.history.entries.length + 1);
});
test("factory and OPFS user presets survive reload, including persisted convolution assets remapped to the new kernel", async ({
  page,
}) => {
  await load(page);
  let dialog = await openEffect(page, "distortion");
  const factory = dialog.getByLabel("Factory preset", { exact: true });
  await expect(factory.locator("option")).not.toHaveCount(1);
  await factory.selectOption({ index: 1 });
  await dialog.getByLabel("Preset name", { exact: true }).fill("Browser rack");
  await dialog.getByRole("button", { name: "Save preset", exact: true }).click();
  await expect(
    dialog
      .getByLabel("User preset", { exact: true })
      .getByRole("option", { name: "Browser rack", exact: true }),
  ).toHaveCount(1);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.reload();
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
  await load(page);
  dialog = await openEffect(page);
  await dialog.getByLabel("User preset", { exact: true }).selectOption({ label: "Browser rack" });
  await expect(dialog.locator('[data-effect-id="distortion"]')).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  dialog = await openEffect(page, "reverb-conv");
  await dialog.getByLabel("Impulse response WAV", { exact: true }).setInputFiles({
    name: "persisted-impulse.wav",
    mimeType: "audio/wav",
    buffer: fixture([[1]], 48000),
  });
  await expect(dialog.getByRole("button", { name: "Preview", exact: true })).toBeEnabled();
  await dialog.getByLabel("Preset name", { exact: true }).fill("Browser convolution");
  await dialog.getByRole("button", { name: "Save preset", exact: true }).click();
  await expect(
    dialog
      .getByLabel("User preset", { exact: true })
      .getByRole("option", { name: "Browser convolution", exact: true }),
  ).toHaveCount(1);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.reload();
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
  await load(page);
  dialog = await openEffect(page);
  await dialog
    .getByLabel("User preset", { exact: true })
    .selectOption({ label: "Browser convolution" });
  await expect(dialog).toContainText("persisted-impulse.wav");
  await expect(dialog.getByRole("button", { name: "Preview", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(dialog.getByTestId("effects-status")).toHaveText("Previewing live effects");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).not.toBeVisible();
});
test("custom EQ and dynamics curves come from the kernel and EQ pointer editing changes actual parameters", async ({
  page,
}) => {
  await load(page);
  let dialog = await openEffect(page, "eq-parametric");
  const curve = dialog.getByRole("img", { name: /response curve/ });
  await expect(curve.locator("path[data-testid=effect-response-path]")).not.toHaveAttribute(
    "d",
    "",
  );
  const previous = await dialog
    .locator("input[type=number]")
    .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
  await curve.scrollIntoViewIfNeeded();
  const box = await curve.boundingBox();
  if (!box) throw new Error("curve missing");
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.25);
  await expect
    .poll(() =>
      dialog
        .locator("input[type=number]")
        .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)),
    )
    .not.toEqual(previous);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  dialog = await openEffect(page, "dyn-compressor");
  await expect(
    dialog
      .getByRole("img", { name: /response curve/ })
      .locator("path[data-testid=effect-response-path]"),
  ).not.toHaveAttribute("d", "");
  await expect(dialog).toContainText("dB input");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  dialog = await openEffect(page, "filter");
  await dialog.getByLabel("Family", { exact: true }).selectOption("moog");
  await expect(dialog.getByRole("img", { name: /response curve/ })).toHaveCount(0);
  await expect(dialog).toContainText("Moog response depends on the input signal");
  await expect(dialog.getByRole("spinbutton", { name: "Freq (Hz)", exact: true })).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
});
test("Escape cancels an offline effects render without changing source or history", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const source = Array.from({ length: 48000 * 15 }, () => 0.125);
  await load(page, [source, source]);
  const before = await sourceState(page);
  const dialog = await openEffect(page, "reverb-freeverb");
  await dialog.getByRole("button", { name: "Apply rack", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  expect(await sourceState(page)).toEqual(before);
  expect(await samples(page)).toEqual([source, source]);
});

test("stereo descriptors remain discoverable but disabled for mono and incomplete selected pairs", async ({
  page,
}) => {
  await load(page, [LEFT]);
  const effects = (await catalogue(page)).effects.filter(
    (descriptor) => descriptor.channelMode === "stereo",
  );
  expect(effects.length).toBeGreaterThan(0);
  for (const descriptor of effects) {
    await expect(await showEffectMenuItem(page, descriptor.id)).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  }
  await load(page);
  await (
    await revealControl(
      page.getByRole("button", { name: "Right", exact: true, includeHidden: true }),
    )
  ).click();
  for (const descriptor of effects) {
    await expect(await showEffectMenuItem(page, descriptor.id)).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  }
  const dialog = await openEffect(page);
  for (const descriptor of effects)
    await expect(
      dialog.getByLabel("Add effect", { exact: true }).locator(`option[value="${descriptor.id}"]`),
    ).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
});
