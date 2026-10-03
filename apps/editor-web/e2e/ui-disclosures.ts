/// <reference lib="dom" />
import type { Locator } from "@playwright/test";

/** Exercise the real disclosure, rather than making hidden controls test-visible. */
export async function revealControl(control: Locator): Promise<Locator> {
  if (!(await control.isVisible())) {
    const details = control.locator("xpath=ancestor::details[1]");
    await details.locator("summary").first().click();
  }
  return control;
}
