/// <reference lib="dom" />
import type { Locator } from "@playwright/test";

/** Exercise the real disclosure, rather than making hidden controls test-visible. */
export async function revealControl(control: Locator): Promise<Locator> {
  if (!(await control.isVisible())) {
    // A view-band popover can cover a trigger in the selection row. Dismiss
    // the current disclosure through its real summary before opening another.
    const openSummary = control.page().locator('details[name="editor-controls"][open] > summary');
    if (await openSummary.count()) await openSummary.click();
    const details = control.locator("xpath=ancestor::details[1]");
    await details.locator("summary").first().click();
  }
  return control;
}
