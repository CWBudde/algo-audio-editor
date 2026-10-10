import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getPreferences, updatePreferences } from "@/lib/preferences";
import { PreferencesDialog } from "./preferences-dialog";

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.open = true;
    }),
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.open = false;
    }),
  });
});
afterEach(cleanup);

it("shows the stored preferences and saves each change immediately", () => {
  updatePreferences({ timeFormat: "hms", snap: { zero: false, markers: true, ticks: false } });
  const ui = render(<PreferencesDialog open onClose={vi.fn()} />);
  ui.getByRole("dialog", { name: "Preferences" });
  expect((ui.getByLabelText("Default export format") as HTMLSelectElement).value).toBe("source");
  expect((ui.getByLabelText("Default dither") as HTMLSelectElement).value).toBe("auto");
  expect((ui.getByLabelText("Time format") as HTMLSelectElement).value).toBe("hms");
  expect((ui.getByLabelText("Snap to markers / regions") as HTMLInputElement).checked).toBe(true);
  expect(document.activeElement).toBe(ui.getByLabelText("Default export format"));

  fireEvent.change(ui.getByLabelText("Default export format"), { target: { value: "aiff" } });
  fireEvent.change(ui.getByLabelText("Default dither"), { target: { value: "none" } });
  fireEvent.change(ui.getByLabelText("Time format"), { target: { value: "samples" } });
  fireEvent.click(ui.getByLabelText("Snap to zero crossings"));
  fireEvent.click(ui.getByLabelText("Snap to markers / regions"));
  fireEvent.click(ui.getByLabelText("Snap to ruler ticks"));
  expect(getPreferences()).toEqual({
    exportFormat: "aiff",
    exportDither: "none",
    timeFormat: "samples",
    snap: { zero: true, markers: false, ticks: true },
  });
  expect((ui.getByLabelText("Time format") as HTMLSelectElement).value).toBe("samples");
});

it("follows changes made elsewhere and closes on Close or Escape", () => {
  const onClose = vi.fn();
  const ui = render(<PreferencesDialog open onClose={onClose} />);
  act(() => updatePreferences({ timeFormat: "hms" }));
  expect((ui.getByLabelText("Time format") as HTMLSelectElement).value).toBe("hms");
  fireEvent.click(ui.getByRole("button", { name: "Close" }));
  fireEvent(ui.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(onClose).toHaveBeenCalledTimes(2);
});
