import type { EffectDescriptor } from "@aae/protocol";
import type { Page } from "@playwright/test";
import { effectMenuCategory } from "../src/lib/effect-menu.js";

export async function showEffectMenuItem(page: Page, id: string) {
  await page.getByRole("menuitem", { name: "Effects", exact: true }).click();
  if (id !== "rack") {
    const descriptor = await page.evaluate(async (effectId) => {
      const result = (await window.__aaeTest?.request("effects.list", { sampleRate: 48000 })) as {
        effects: EffectDescriptor[];
      };
      return result.effects.find((effect) => effect.id === effectId);
    }, id);
    if (!descriptor) throw new Error(`Unknown effect: ${id}`);
    await page.getByRole("menuitem", { name: effectMenuCategory(descriptor), exact: true }).click();
  }
  return page.locator(`[role="menuitem"][data-command-id="effects.${id}"]`);
}
