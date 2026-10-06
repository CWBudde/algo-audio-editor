/// <reference lib="dom" />
import { expect, type Locator, test } from "@playwright/test";
import { runCommand } from "./command-fixture.ts";
import { load, samples } from "./edit-fixture.ts";
import { showEffectMenuItem } from "./effect-menu.ts";
import { sourceState } from "./export-fixture.ts";
import { captureKernelWorker } from "./kernel-probe.ts";
import { revealControl } from "./ui-disclosures.ts";

// Observe painted styles in the production app. Resolve alpha surfaces through
// their real ancestors, so transparent fields cannot pass against a fictitious
// opaque token. No fixed palette RGB values are duplicated in this test.
async function paint(locator: Locator) {
  return locator.evaluate((element) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("color context missing");
    const rgba = (value: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    };
    const ancestors: Element[] = [];
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement)
      ancestors.unshift(ancestor);
    let background = [255, 255, 255];
    for (const ancestor of ancestors) {
      const [red, green, blue, alpha] = rgba(getComputedStyle(ancestor).backgroundColor);
      background = [red, green, blue].map(
        (channel, index) => channel * (alpha / 255) + background[index] * (1 - alpha / 255),
      );
    }
    const style = getComputedStyle(element);
    const role = (property: string) => {
      const value = style.getPropertyValue(property).trim();
      if (!value) throw new Error(`Missing palette role ${property}`);
      return rgba(value).slice(0, 3);
    };
    return {
      foreground: rgba(style.color).slice(0, 3),
      background,
      backgroundStyle: style.backgroundColor,
      border: rgba(style.borderTopColor).slice(0, 3),
      outline: rgba(style.outlineColor).slice(0, 3),
      outlineWidth: Number.parseFloat(style.outlineWidth),
      outlineStyle: style.outlineStyle,
      stroke: rgba(style.stroke === "currentcolor" ? style.color : style.stroke).slice(0, 3),
      shadow: style.boxShadow,
      opacity: Number(style.opacity),
      primary: role("--editor-primary"),
      focus: role("--editor-focus"),
      peak: role("--editor-waveform-peak"),
      track: role("--editor-control-track"),
      playhead: role("--editor-playhead"),
      warning: role("--editor-warning"),
      error: role("--editor-error"),
    };
  });
}

function contrast(a: number[], b: number[]) {
  const luminance = (rgb: number[]) =>
    rgb
      .map((value) => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      })
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const light = luminance(a);
  const dark = luminance(b);
  return (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
}

async function readable(locator: Locator) {
  await expect(locator).toBeVisible();
  const colors = await paint(locator);
  expect(contrast(colors.foreground, colors.background)).toBeGreaterThanOrEqual(4.5);
  return colors;
}

test.beforeEach(async ({ page }) => {
  await captureKernelWorker(page);
  await page.goto("/");
  await expect(page.locator("[data-kernel-state]")).toHaveAttribute("data-kernel-state", "ready");
});

test("multichannel spectrum traces remain readable and distinct from processing warnings", async ({
  page,
}) => {
  const source = Array.from({ length: 4096 }, (_, index) => (index % 2 ? 0.5 : -0.5));
  await load(page, [source, source, source, source]);
  const before = await sourceState(page);
  await runCommand(page, "analyze.spectrum", "Analyze");
  const spectrum = page.getByRole("region", { name: "Spectrum analyzer" });
  const paths = spectrum.getByTestId("spectrum-path");
  await expect(paths).toHaveCount(4);
  const traces: number[][] = [];
  for (const path of await paths.all()) {
    await expect(path).toHaveAttribute("d", /^M\S+/);
    const colors = await paint(path);
    expect(contrast(colors.stroke, colors.background)).toBeGreaterThanOrEqual(3);
    expect(colors.stroke).not.toEqual(colors.error);
    expect(colors.stroke).not.toEqual(colors.warning);
    traces.push(colors.stroke);
  }
  expect(new Set(traces.map((color) => color.join(","))).size).toBe(4);
  await spectrum.getByRole("button", { name: "Close spectrum" }).click();

  await runCommand(page, "process.amplify", "Process");
  const dialog = page.getByRole("dialog", { name: "Amplify", exact: true });
  await dialog.getByLabel("Gain (dB)", { exact: true }).fill("24");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  const warning = dialog.getByRole("alert");
  await expect(warning).toContainText("may clip");
  const warningPaint = await readable(warning);
  expect(warningPaint.foreground).toEqual(warningPaint.warning);
  for (const trace of traces) expect(warningPaint.foreground).not.toEqual(trace);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(await sourceState(page)).toEqual(before);
  expect(await samples(page)).toEqual([source, source, source, source]);
});

test("workspace text, focus and selected controls remain legible without changing the source", async ({
  page,
}) => {
  const play = page.getByTestId("play");
  await expect(play).toBeDisabled();
  const inactive = await paint(play);
  await load(page);
  const before = await sourceState(page);
  const originalSamples = await samples(page);
  await expect(play).toBeEnabled();
  expect((await paint(play)).opacity).toBeGreaterThan(inactive.opacity);

  const selection = page.getByLabel("Selection start", { exact: true });
  await readable(selection);
  await readable(page.getByTestId("document-details"));
  await page.keyboard.press("Tab");
  await selection.focus();
  await expect(selection).toBeFocused();
  const focused = await paint(selection);
  expect(focused.outlineStyle).not.toBe("none");
  expect(focused.outlineWidth).toBeGreaterThanOrEqual(2);
  expect(focused.outline).toEqual(focused.focus);
  expect(contrast(focused.outline, focused.background)).toBeGreaterThanOrEqual(3);

  const loop = page.getByRole("checkbox", { name: "Loop", exact: true });
  const loopFace = loop.locator("..");
  const unchecked = await paint(loopFace);
  await loop.check();
  await expect(loop).toBeChecked();
  const checked = await paint(loopFace);
  expect(checked.foreground).toEqual(checked.primary);
  expect(checked.background).not.toEqual(unchecked.background);
  expect(contrast(checked.foreground, checked.background)).toBeGreaterThanOrEqual(3);
  await loop.uncheck();

  const all = await revealControl(
    page.getByRole("button", { name: "All", exact: true, includeHidden: true }),
  );
  const left = page.getByRole("button", { name: "Left", exact: true });
  await expect(all).toHaveAttribute("aria-pressed", "true");
  const selected = await readable(all);
  const unselected = await readable(left);
  expect(
    selected.background,
    JSON.stringify({
      selected: selected.backgroundStyle,
      unselected: unselected.backgroundStyle,
    }),
  ).not.toEqual(unselected.background);
  expect(selected.foreground).toEqual(selected.primary);
  expect(selected.border).toEqual(selected.primary);
  await left.click();
  await expect(left).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(0, 0);
  await expect.poll(async () => (await paint(left)).background).toEqual(selected.background);
  await all.click();
  await page.keyboard.press("Escape");
  expect(await sourceState(page)).toEqual(before);
  expect(await samples(page)).toEqual(originalSamples);
});

test("effect curves, knobs, fields and actions share visible palette roles", async ({ page }) => {
  await load(page);
  const before = await sourceState(page);
  const originalSamples = await samples(page);
  await (await showEffectMenuItem(page, "eq-parametric")).click();
  const dialog = page.getByRole("dialog", { name: "Effects rack" });
  await expect(dialog.getByTestId("effects-status")).toHaveText("Ready");
  await readable(dialog.locator(".studio-dialog-help"));
  await readable(dialog.getByRole("button", { name: "Apply rack", exact: true }));
  await readable(dialog.getByLabel("Add effect", { exact: true }));

  const curve = dialog.getByTestId("effect-response-path");
  await expect(curve).toHaveAttribute("d", /^M\S+/);
  const curvePaint = await paint(curve);
  expect(curvePaint.stroke).toEqual(curvePaint.peak);
  expect(contrast(curvePaint.stroke, curvePaint.background)).toBeGreaterThanOrEqual(3);
  const knob = dialog.getByRole("slider", { name: /knob$/ }).first();
  const arcs = knob.locator("path");
  const trackPaint = await paint(arcs.nth(0));
  const activePaint = await paint(arcs.nth(1));
  expect(trackPaint.stroke).toEqual(trackPaint.track);
  expect(activePaint.stroke).toEqual(activePaint.primary);
  expect(trackPaint.stroke).not.toEqual(activePaint.stroke);
  expect(contrast(trackPaint.stroke, trackPaint.background)).toBeGreaterThanOrEqual(3);
  expect(contrast(activePaint.stroke, activePaint.background)).toBeGreaterThanOrEqual(3);
  const pointerPaint = await paint(knob.locator("line"));
  expect(pointerPaint.stroke).toEqual(pointerPaint.peak);

  const field = dialog.locator("input[type=number]").first();
  await readable(field);
  const fieldFace = field.locator("..");
  const blurred = await paint(fieldFace);
  expect(contrast(blurred.border, blurred.background)).toBeGreaterThanOrEqual(3);
  await page.keyboard.press("Tab");
  await field.focus();
  const focused = await paint(fieldFace);
  expect(focused.shadow).not.toEqual(blurred.shadow);
  expect(focused.shadow).not.toBe("none");
  await knob.focus();
  await expect(knob).toBeFocused();
  expect((await paint(knob)).shadow).not.toBe("none");
  await knob.press("ArrowUp");
  const readout = await readable(dialog.locator(".studio-readout[aria-live=polite]"));
  expect(readout.foreground).toEqual(readout.playhead);
  expect(readout.foreground).not.toEqual(activePaint.stroke);
  expect(curvePaint.stroke).not.toEqual(activePaint.stroke);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(await sourceState(page)).toEqual(before);
  expect(await samples(page)).toEqual(originalSamples);
});
