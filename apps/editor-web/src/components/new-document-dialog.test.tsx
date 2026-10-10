import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NewDocumentDialog } from "./new-document-dialog";

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

it("creates an empty 48 kHz stereo document by default", () => {
  const onCreate = vi.fn();
  const ui = render(<NewDocumentDialog open onCreate={onCreate} onClose={vi.fn()} />);
  const dialog = ui.getByRole("dialog", { name: "New document" });
  expect((ui.getByLabelText("Sample rate") as HTMLSelectElement).value).toBe("48000");
  expect((ui.getByLabelText("Channels") as HTMLSelectElement).value).toBe("2");
  expect((ui.getByLabelText("Length (seconds)") as HTMLInputElement).value).toBe("0");
  expect(document.activeElement).toBe(ui.getByLabelText("Sample rate"));
  fireEvent.click(ui.getByRole("button", { name: "Create" }));
  expect(onCreate).toHaveBeenCalledWith({ sampleRate: 48000, channels: 2, frames: 0 });
  expect(dialog).toBeDefined();
});

it("converts the chosen silent length to whole frames at the chosen rate", () => {
  const onCreate = vi.fn();
  const ui = render(<NewDocumentDialog open onCreate={onCreate} onClose={vi.fn()} />);
  fireEvent.change(ui.getByLabelText("Sample rate"), { target: { value: "44100" } });
  fireEvent.change(ui.getByLabelText("Channels"), { target: { value: "1" } });
  fireEvent.change(ui.getByLabelText("Length (seconds)"), { target: { value: "2.5" } });
  fireEvent.click(ui.getByRole("button", { name: "Create" }));
  expect(onCreate).toHaveBeenCalledWith({ sampleRate: 44100, channels: 1, frames: 110250 });
});

it.each(["-1", "NaN", "", "86401"])("rejects the length %j without creating", (text) => {
  const onCreate = vi.fn();
  const ui = render(<NewDocumentDialog open onCreate={onCreate} onClose={vi.fn()} />);
  fireEvent.change(ui.getByLabelText("Length (seconds)"), { target: { value: text } });
  expect(ui.getByRole("alert").textContent).toContain("between 0 and 86,400 seconds");
  const create = ui.getByRole("button", { name: "Create" }) as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  fireEvent.submit(create.form as HTMLFormElement);
  expect(onCreate).not.toHaveBeenCalled();
});

it("offers one to eight channels and closes on Cancel or Escape", () => {
  const onClose = vi.fn();
  const ui = render(<NewDocumentDialog open onCreate={vi.fn()} onClose={onClose} />);
  const options = [...(ui.getByLabelText("Channels") as HTMLSelectElement).options];
  expect(options.map((option) => option.value)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
  expect(options.slice(0, 2).map((option) => option.text)).toEqual(["1 (mono)", "2 (stereo)"]);
  fireEvent.click(ui.getByRole("button", { name: "Cancel" }));
  fireEvent(ui.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(onClose).toHaveBeenCalledTimes(2);
});

it("starts from the defaults again each time it opens", () => {
  const ui = render(<NewDocumentDialog open onCreate={vi.fn()} onClose={vi.fn()} />);
  fireEvent.change(ui.getByLabelText("Length (seconds)"), { target: { value: "3" } });
  ui.rerender(<NewDocumentDialog open={false} onCreate={vi.fn()} onClose={vi.fn()} />);
  ui.rerender(<NewDocumentDialog open onCreate={vi.fn()} onClose={vi.fn()} />);
  expect((ui.getByLabelText("Length (seconds)") as HTMLInputElement).value).toBe("0");
});
