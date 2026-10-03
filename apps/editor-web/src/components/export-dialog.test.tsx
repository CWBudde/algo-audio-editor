import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ExportView } from "@/hooks/use-export";
import { defaultExportSettings } from "@/lib/export-settings";
import { ExportDialog } from "./export-dialog";

const info = {
  documentId: "doc-1",
  name: "audio.wav",
  sampleRate: 48000,
  channels: 2,
  frames: 100,
  bitDepth: 16,
  float: false,
};
const view: ExportView = {
  info,
  selection: { start: 10, end: 30, channelMask: 2 },
  settings: defaultExportSettings(info),
  phase: "idle",
};
const actions = () => ({ onSettingsChange: vi.fn(), onExport: vi.fn(), onCancel: vi.fn() });
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
    },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("offers the current encoding, selected time/channels and all integer quality choices", () => {
  const callbacks = actions();
  const ui = render(
    <ExportDialog
      view={{ ...view, settings: { ...view.settings, scope: "selection" } }}
      {...callbacks}
    />,
  );
  expect(ui.getByRole("dialog", { name: "Export audio" })).toBeTruthy();
  expect(document.activeElement).toBe(ui.getByLabelText("Range"));
  expect(ui.getByText("Frames 10–30 · channels 2")).toBeTruthy();
  expect((ui.getByLabelText("Bit depth") as HTMLSelectElement).value).toBe("16");
  expect(ui.getByLabelText("Dither").querySelectorAll("option")).toHaveLength(5);
  expect(ui.getByLabelText("Noise shaping").querySelectorAll("option")).toHaveLength(6);
  fireEvent.change(ui.getByLabelText("Dither"), { target: { value: "triangular" } });
  expect(callbacks.onSettingsChange).toHaveBeenCalledWith({ dither: "triangular" });
  fireEvent.click(ui.getByRole("button", { name: "Export" }));
  expect(callbacks.onExport).toHaveBeenCalledOnce();
});
it("only offers float depths and hides incompatible quality controls", () => {
  const ui = render(
    <ExportDialog
      view={{ ...view, settings: { ...view.settings, encoding: "float", bitDepth: 64 } }}
      {...actions()}
    />,
  );
  expect(
    Array.from(ui.getByLabelText("Bit depth").querySelectorAll("option"), (option) => option.value),
  ).toEqual(["32", "64"]);
  expect(ui.queryByLabelText("Dither")).toBeNull();
  expect(ui.queryByLabelText("Noise shaping")).toBeNull();
});
it("disables cursor selection and all controls during chooser/export/write, including Escape", () => {
  const callbacks = actions();
  const cursor = { ...view, selection: { ...view.selection, end: 10 } };
  const ui = render(<ExportDialog view={cursor} {...callbacks} />);
  expect(
    ui.getByRole("option", { name: "Selection (selected channels)" }).hasAttribute("disabled"),
  ).toBe(true);
  ui.rerender(<ExportDialog view={{ ...view, phase: "exporting" }} {...callbacks} />);
  for (const select of ui.getAllByRole("combobox"))
    expect((select as HTMLSelectElement).disabled).toBe(true);
  expect((ui.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent(ui.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(callbacks.onCancel).not.toHaveBeenCalled();
});
it("renders errors inside the dialog and restores opener focus on close and unmount", () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const callbacks = actions();
  const ui = render(<ExportDialog view={{ ...view, error: "disk full" }} {...callbacks} />);
  expect(ui.getByRole("alert").textContent).toBe("disk full");
  fireEvent(ui.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(callbacks.onCancel).toHaveBeenCalledOnce();
  ui.rerender(<ExportDialog {...callbacks} />);
  expect(document.activeElement).toBe(opener);
  ui.rerender(<ExportDialog view={view} {...callbacks} />);
  ui.unmount();
  expect(document.activeElement).toBe(opener);
  opener.remove();
});
