/// <reference lib="dom" />
import type { EffectDescriptor } from "@aae/protocol";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { effectMenuEntries, isStandardFilter, isWeightingFilter } from "../src/lib/effect-menu.js";
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
/** Single standard and weighting filters open dedicated editors titled after the filter. */
function effectDialogTitle(id: string) {
  if (isStandardFilter(id)) return "Filter";
  if (isWeightingFilter(id)) return "Weighting filters";
  return "Effects rack";
}
async function openEffect(page: Page, id = "rack") {
  await (await showEffectMenuItem(page, id)).click();
  const dialog = page.getByRole("dialog", { name: effectDialogTitle(id), exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("effects-status")).toHaveText("Ready");
  return dialog;
}
async function apply(dialog: Locator) {
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
  // Filter variants share the consolidated Filter and Weighting filters editors; every
  // remaining menu entry opens its own editor.
  const entries = new Set(effectMenuEntries(effects).map((effect) => effect.id));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const descriptor of effects.filter((effect) => entries.has(effect.id)))
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
      await apply(dialog);
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
      await page.keyboard.press("ControlOrMeta+z");
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
  await apply(reopened);
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
  await (await revealControl(dialog.getByLabel("Preset name", { exact: true }))).fill(
    "Browser rack",
  );
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
  await (await revealControl(dialog.getByLabel("User preset", { exact: true }))).selectOption({
    label: "Browser rack",
  });
  await expect(dialog.locator('[data-effect-id="distortion"]')).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  dialog = await openEffect(page, "reverb-conv");
  await dialog.getByLabel("Impulse response WAV", { exact: true }).setInputFiles({
    name: "persisted-impulse.wav",
    mimeType: "audio/wav",
    buffer: fixture([[1]], 48000),
  });
  await expect(dialog.getByRole("button", { name: "Preview", exact: true })).toBeEnabled();
  await (await revealControl(dialog.getByLabel("Preset name", { exact: true }))).fill(
    "Browser convolution",
  );
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
  await (await revealControl(dialog.getByLabel("User preset", { exact: true }))).selectOption({
    label: "Browser convolution",
  });
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
  await expect(dialog).toContainText("Input (dB)");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  dialog = await openEffect(page, "filter");
  await dialog.getByLabel("Family", { exact: true }).selectOption("moog");
  await expect(dialog.getByRole("img", { name: /response curve/ })).toHaveCount(0);
  await expect(dialog).toContainText("Moog response depends on the input signal");
  await expect(dialog.getByRole("spinbutton", { name: "Cutoff (Hz)", exact: true })).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
});
test("parametric EQ has labeled axes, persistent draggable bands and keyboard controls on desktop and narrow screens", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await load(page);
  const before = await sourceState(page);
  const descriptor = (await catalogue(page)).effects.find(
    (effect) => effect.id === "eq-parametric",
  );
  if (!descriptor) throw new Error("Parametric EQ missing");
  const dialog = await openEffect(page, descriptor.id);
  const graph = dialog.getByRole("group", { name: "Parametric EQ frequency graph" });
  const field = (id: string) => {
    const parameter = descriptor.parameters.find((parameter) => parameter.id === id);
    if (!parameter) throw new Error(`Parameter ${id} missing`);
    return dialog.getByLabel(`${parameter.label}${parameter.unit ? ` (${parameter.unit})` : ""}`, {
      exact: true,
    });
  };
  const bands = dialog.getByRole("combobox", { name: "Bands", exact: true });
  const path = graph.getByTestId("effect-response-path");
  await expect(path).toHaveAttribute("d", /^M\S+/);
  await expect(graph.getByText("Frequency (Hz)")).toBeVisible();
  await expect(graph.getByText("Gain (dB)")).toBeVisible();
  await expect(graph.getByRole("slider")).toHaveCount(6);
  await expect(field("band7FreqHz")).toHaveCount(0);
  const initialPath = await path.getAttribute("d");
  // Band 1 defaults to a highpass whose gain is inactive; band 3 is the peak default peak band.
  const peak = graph.getByRole("slider", { name: "EQ band 3", exact: true });
  await peak.focus();
  await peak.press("ArrowUp");
  await expect(field("band3GainDB")).toHaveValue("0.5");
  await expect(path).not.toHaveAttribute("d", initialPath ?? "");
  await peak.press("+");
  await expect(field("band3Q")).toHaveValue("1.1");
  await peak.click({ button: "right" });
  const types = dialog.getByRole("menu", { name: "Band 3 filter type" });
  await expect(types).toBeVisible();
  const shelf = descriptor.parameters
    .find((parameter) => parameter.id === "band3Type")
    ?.options?.find((option) => option.value === "lowshelf");
  if (!shelf) throw new Error("Low shelf type missing");
  await types.getByRole("menuitemradio", { name: shelf.label }).click();
  await expect(field("band3Type")).toHaveValue("lowshelf");
  await expect(field("band3GainDB")).toHaveValue("0.5");
  await peak.focus();
  await peak.press("Shift+F10");
  await expect(types).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(types).not.toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(peak).toBeFocused();
  const secondFrequency = await field("band2FreqHz").inputValue();
  const box = await graph.boundingBox();
  const handle = await peak.boundingBox();
  if (!box || !handle) throw new Error("EQ geometry missing");
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  // The plot spans x 52…width-20 (20 Hz…20 kHz, log) and y 20…170 of 220 (+24…-24 dB).
  await page.mouse.move(
    box.x + 52 + ((box.width - 72) * Math.log(5000 / 20)) / Math.log(1000),
    box.y + (box.height * 57.5) / 220,
    { steps: 12 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => Number(await field("band3FreqHz").inputValue()))
    .toBeCloseTo(5000, -1);
  await expect.poll(async () => Number(await field("band3GainDB").inputValue())).toBeCloseTo(12, 0);
  await expect(field("band2FreqHz")).toHaveValue(secondFrequency);
  expect(await sourceState(page)).toEqual(before);
  await testInfo.attach("parametric-eq-desktop", {
    body: await graph.screenshot({ path: testInfo.outputPath("parametric-eq-desktop.png") }),
    contentType: "image/png",
  });
  await bands.selectOption("8");
  await expect(graph.getByRole("slider")).toHaveCount(8);
  await dialog.screenshot({ path: testInfo.outputPath("parametric-eq-full-hd-dialog.png") });
  const layout = await dialog.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    width: element.clientWidth,
    graph: element
      .querySelector("svg[aria-label='Parametric EQ frequency graph']")
      ?.getBoundingClientRect().height,
    cards: Array.from(element.querySelectorAll("fieldset")).map(
      (card) => card.getBoundingClientRect().height,
    ),
  }));
  expect(layout.scrollHeight <= layout.clientHeight, JSON.stringify(layout)).toBe(true);
  expect(layout.clientHeight).toBeLessThan(1000);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const gainKnob = dialog.getByRole("slider", {
    name: `${descriptor.parameters.find((parameter) => parameter.id === "band3GainDB")?.label} knob`,
    exact: true,
  });
  const gainBeforeKnob = Number(await field("band3GainDB").inputValue());
  await gainKnob.focus();
  await gainKnob.press("ArrowDown");
  await expect
    .poll(async () => Number(await field("band3GainDB").inputValue()))
    .toBeLessThan(gainBeforeKnob);
  const knobBox = await gainKnob.boundingBox();
  if (!knobBox) throw new Error("Gain knob geometry missing");
  const beforeDrag = Number(await field("band3GainDB").inputValue());
  await page.mouse.move(knobBox.x + knobBox.width / 2, knobBox.y + knobBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(knobBox.x + knobBox.width / 2, knobBox.y + knobBox.height / 2 + 12);
  await page.mouse.up();
  await expect
    .poll(async () => Number(await field("band3GainDB").inputValue()))
    .toBeLessThan(beforeDrag);
  await testInfo.attach("parametric-eq-full-hd-dialog", {
    body: await dialog.screenshot({
      path: testInfo.outputPath("parametric-eq-full-hd-dialog.png"),
    }),
    contentType: "image/png",
  });
  await bands.selectOption("1");
  await expect(graph.getByRole("slider")).toHaveCount(1);
  await page.setViewportSize({ width: 640, height: 720 });
  await bands.selectOption("8");
  await expect(graph.getByRole("slider")).toHaveCount(8);
  await graph.scrollIntoViewIfNeeded();
  await expect(graph).toBeVisible();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await testInfo.attach("parametric-eq-narrow", {
    body: await graph.screenshot({ path: testInfo.outputPath("parametric-eq-narrow.png") }),
    contentType: "image/png",
  });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await sourceState(page)).toEqual(before);
});
test("dynamics graphs expose kernel I/O samples, guides and keyboard readouts without changing audio", async ({
  page,
}, testInfo) => {
  await load(page);
  const before = await sourceState(page);
  const effects = (await catalogue(page)).effects.filter((effect) => effect.view === "dynamics");
  expect(effects.map((effect) => effect.id).sort()).toEqual([
    "dyn-compressor",
    "dyn-expander",
    "dyn-gate",
    "dyn-limiter",
    "dyn-lookahead",
  ]);
  for (const descriptor of effects) {
    const dialog = await openEffect(page, descriptor.id);
    const graph = dialog.getByRole("img", {
      name: `${descriptor.name} response curve`,
      exact: true,
    });
    const path = graph.getByTestId("effect-response-path");
    await expect(path).toHaveAttribute("d", /^M\S+/);
    await expect(graph.getByText("Input (dB)")).toBeVisible();
    await expect(graph.getByText("Output (dB)")).toBeVisible();
    await expect(graph.getByTestId("dynamics-unity")).toBeVisible();
    const threshold = descriptor.parameters.find((parameter) => parameter.id === "thresholdDB");
    if (!threshold) throw new Error("Threshold parameter missing");
    // Compact dynamics plots map -80…0 dB input onto x 56…336 of a 360×360 view box.
    await expect(graph.getByTestId("dynamics-threshold")).toHaveAttribute(
      "x1",
      String(56 + ((threshold.default + 80) * 280) / 80),
    );
    const readout = dialog.locator("output[aria-live=polite]");
    await graph.focus();
    await graph.press("End");
    const output = await page.evaluate(async (effect) => {
      const response = (await window.__aaeTest?.request("effects.response", {
        effectId: effect.id,
        params: Object.fromEntries(
          effect.parameters.map((parameter) => [
            parameter.id,
            parameter.defaultString || parameter.default,
          ]),
        ),
        sampleRate: 48000,
        points: 256,
        mode: "transfer",
      })) as { count: number; data: ArrayBuffer };
      return new DataView(response.data).getFloat64((response.count - 1) * 16 + 8, true);
    }, descriptor);
    const db = `${output > 0 ? "+" : ""}${output.toFixed(1)} dB`;
    await expect(readout).toHaveText(`Input 0.0 dB → Output ${db} · Gain change ${db}`);
    const initialReadout = await readout.textContent();
    await graph.press("ArrowLeft");
    await expect(readout).not.toHaveText(initialReadout ?? "");
    await graph.scrollIntoViewIfNeeded();
    const box = await graph.boundingBox();
    if (!box) throw new Error("Dynamics geometry missing");
    await page.mouse.move(box.x + (box.width * 196) / 360, box.y + (box.height * 100) / 360);
    await expect
      .poll(async () => Number(/Input ([\d.-]+)/.exec((await readout.textContent()) ?? "")?.[1]))
      .toBeCloseTo(-40, 0);
    const parameter = descriptor.parameters.find((parameter) => parameter.id === "thresholdDB");
    if (!parameter) throw new Error("Threshold parameter missing");
    const field = dialog.getByLabel(
      `${parameter.label}${parameter.unit ? ` (${parameter.unit})` : ""}`,
      { exact: true },
    );
    const oldPath = await path.getAttribute("d");
    await field.fill("-10");
    await expect(path).not.toHaveAttribute("d", oldPath ?? "");
    await expect(graph.getByTestId("dynamics-threshold")).toHaveAttribute("x1", "301");
    expect(await sourceState(page)).toEqual(before);
    if (descriptor.id === "dyn-compressor") {
      await testInfo.attach("dynamics-desktop", {
        body: await graph.screenshot({ path: testInfo.outputPath("dynamics-desktop.png") }),
        contentType: "image/png",
      });
      await page.setViewportSize({ width: 640, height: 720 });
      await graph.scrollIntoViewIfNeeded();
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await testInfo.attach("dynamics-narrow", {
        body: await graph.screenshot({ path: testInfo.outputPath("dynamics-narrow.png") }),
        contentType: "image/png",
      });
      await page.setViewportSize({ width: 1280, height: 720 });
    }
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await sourceState(page)).toEqual(before);
  }
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
