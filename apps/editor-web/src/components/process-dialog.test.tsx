import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProcessView } from "@/hooks/use-process";
import { ProcessDialog } from "./process-dialog";

const view: ProcessView = {
  info: {
    documentId: "doc-1",
    name: "audio.wav",
    sampleRate: 48000,
    channels: 2,
    frames: 100,
    bitDepth: 16,
    float: false,
  },
  selection: { start: 10, end: 30, channelMask: 2 },
  gainText: "6",
  phase: "idle",
  previewing: false,
};
const callbacks = () => ({
  onGainTextChange: vi.fn(),
  onPreview: vi.fn(),
  onStopPreview: vi.fn(),
  onApply: vi.fn(),
  onCancel: vi.fn(),
});
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
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("opens an accessible modal and gives the gain field initial focus", () => {
  const actions = callbacks();
  const ui = render(<ProcessDialog view={view} {...actions} />);
  expect(ui.getByRole("dialog", { name: "Amplify" }).textContent).toContain("frames 10–30");
  const field = ui.getByLabelText("Gain (dB)");
  expect(document.activeElement).toBe(field);
  fireEvent.change(field, { target: { value: "-6" } });
  expect(actions.onGainTextChange).toHaveBeenCalledWith("-6");
  fireEvent.click(ui.getByRole("button", { name: "Preview" }));
  fireEvent.click(ui.getByRole("button", { name: "Apply" }));
  expect(actions.onPreview).toHaveBeenCalledOnce();
  expect(actions.onApply).toHaveBeenCalledWith(false);
});

it("keeps Cancel available while processing and displays native progress", () => {
  const actions = callbacks();
  const job = {
    ...view.selection,
    documentId: "doc-1",
    jobId: "process-1",
    operation: "gain" as const,
    state: "running" as const,
    gainDb: 6,
    processedFrames: 5,
    totalFrames: 20,
    peak: 0.25,
    nonFinite: false,
  };
  const ui = render(<ProcessDialog view={{ ...view, phase: "processing", job }} {...actions} />);
  expect(ui.getByLabelText("Processing progress").getAttribute("value")).toBe("5");
  expect((ui.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
  expect((ui.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent(ui.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(actions.onCancel).toHaveBeenCalledOnce();
  ui.rerender(<ProcessDialog view={{ ...view, phase: "committing", job }} {...actions} />);
  fireEvent(ui.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(actions.onCancel).toHaveBeenCalledOnce();
});

it("warns only for the prepared settings and requires explicit Apply anyway", () => {
  const actions = callbacks();
  const job = {
    ...view.selection,
    documentId: "doc-1",
    jobId: "process-1",
    operation: "gain" as const,
    state: "ready" as const,
    gainDb: 6,
    processedFrames: 20,
    totalFrames: 20,
    peak: 2,
    nonFinite: false,
  };
  const ui = render(<ProcessDialog view={{ ...view, phase: "ready", job }} {...actions} />);
  expect(ui.getByRole("alert").textContent).toContain("PCM export may clip");
  fireEvent.click(ui.getByRole("button", { name: "Apply anyway" }));
  expect(actions.onApply).toHaveBeenCalledWith(true);
  ui.rerender(
    <ProcessDialog view={{ ...view, gainText: "-6", phase: "ready", job }} {...actions} />,
  );
  expect(ui.queryByRole("alert")).toBeNull();
  fireEvent.click(ui.getByRole("button", { name: "Apply" }));
  expect(actions.onApply).toHaveBeenLastCalledWith(false);
});

it("invalid gain disables Preview and Apply but never prevents cancellation", () => {
  const actions = callbacks();
  const ui = render(<ProcessDialog view={{ ...view, gainText: "Infinity" }} {...actions} />);
  expect(ui.getByLabelText("Gain (dB)").getAttribute("aria-invalid")).toBe("true");
  expect((ui.getByRole("button", { name: "Preview" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(ui.getByRole("button", { name: "Cancel" }));
  expect(actions.onCancel).toHaveBeenCalledOnce();
});

it("controlled close restores the opener after React's focus commit", () => {
  const actions = callbacks();
  const ui = render(
    <>
      <button type="button">Launcher</button>
      <ProcessDialog {...actions} />
    </>,
  );
  const opener = ui.getByRole("button", { name: "Launcher" });
  opener.focus();
  ui.rerender(
    <>
      <button type="button">Launcher</button>
      <ProcessDialog view={view} {...actions} />
    </>,
  );
  ui.rerender(
    <>
      <button type="button">Launcher</button>
      <ProcessDialog {...actions} />
    </>,
  );
  expect(document.activeElement).toBe(opener);
});
