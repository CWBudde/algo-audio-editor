import type { ProcessJobResult } from "@aae/protocol";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProcessView } from "@/hooks/use-process";
import { defaultProcessSettings } from "@/lib/process-settings";
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
  operation: "gain",
  parameterText: "6",
  phase: "idle",
  previewing: false,
};
const callbacks = () => ({
  onParameterTextChange: vi.fn(),
  onOperationChange: vi.fn(),
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

it("offers all fade curves and direction while retaining private preview actions", () => {
  const actions = { ...callbacks(), onSettingsChange: vi.fn() };
  const ui = render(
    <ProcessDialog
      view={{
        ...view,
        operation: "fade-in",
        parameterText: "",
        settings: defaultProcessSettings(view.info),
      }}
      {...actions}
    />,
  );
  expect(ui.getByRole("dialog", { name: "Fade In / Out" })).toBeTruthy();
  expect(document.activeElement).toBe(ui.getByLabelText("Direction"));
  expect(ui.getByLabelText("Curve").querySelectorAll("option")).toHaveLength(4);
  fireEvent.change(ui.getByLabelText("Direction"), { target: { value: "fade-out" } });
  expect(actions.onOperationChange).toHaveBeenCalledWith("fade-out");
  fireEvent.change(ui.getByLabelText("Curve"), { target: { value: "s-curve" } });
  expect(actions.onSettingsChange).toHaveBeenCalledWith({ curve: "s-curve" });
  expect((ui.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(false);
});

it("shows generator controls for selection replacement and validates sweep frequency", () => {
  const actions = { ...callbacks(), onSettingsChange: vi.fn() };
  const settings = {
    ...defaultProcessSettings(view.info),
    generator: "log-sweep" as const,
    endFrequencyText: "0",
  };
  const ui = render(
    <ProcessDialog
      view={{ ...view, operation: "generate", settings, parameterText: "" }}
      {...actions}
    />,
  );
  expect(ui.getByText(/Replace the selected/)).toBeTruthy();
  expect(ui.queryByLabelText("Duration (seconds)")).toBeNull();
  expect(ui.getByLabelText("Start frequency (Hz)")).toBeTruthy();
  expect(ui.getByLabelText("End frequency (Hz)")).toBeTruthy();
  expect((ui.getByRole("button", { name: "Preview" }) as HTMLButtonElement).disabled).toBe(true);
  expect(ui.getByRole("alert")).toBeTruthy();
  fireEvent.change(ui.getByLabelText("Generator"), { target: { value: "white-noise" } });
  expect(actions.onSettingsChange).toHaveBeenCalledWith({ generator: "white-noise" });
});

it("exposes full-document resampling quality and extraction channel choices", () => {
  const actions = { ...callbacks(), onSettingsChange: vi.fn() };
  const settings = defaultProcessSettings(view.info);
  const ui = render(
    <ProcessDialog
      view={{ ...view, operation: "resample", settings, parameterText: "" }}
      {...actions}
    />,
  );
  expect(ui.getByText("Processes the whole document.")).toBeTruthy();
  expect((ui.getByLabelText("Quality") as HTMLSelectElement).value).toBe("balanced");
  fireEvent.change(ui.getByLabelText("Sample rate (Hz)"), { target: { value: "44100" } });
  expect(actions.onSettingsChange).toHaveBeenCalledWith({ sampleRateText: "44100" });
  ui.rerender(
    <ProcessDialog
      view={{ ...view, operation: "extract-channel", settings, parameterText: "" }}
      {...actions}
    />,
  );
  expect(ui.getByLabelText("Channel").querySelectorAll("option")).toHaveLength(2);
  expect(ui.getByRole("button", { name: "Open extracted channel" })).toBeTruthy();
});

it("opens an accessible modal and gives the gain field initial focus", () => {
  const actions = callbacks();
  const ui = render(<ProcessDialog view={view} {...actions} />);
  expect(ui.getByRole("dialog", { name: "Amplify" }).textContent).toContain("frames 10–30");
  const field = ui.getByLabelText("Gain (dB)");
  expect(document.activeElement).toBe(field);
  fireEvent.change(field, { target: { value: "-6" } });
  expect(actions.onParameterTextChange).toHaveBeenCalledWith("-6");
  fireEvent.click(ui.getByRole("button", { name: "Preview" }));
  fireEvent.click(ui.getByRole("button", { name: "Apply" }));
  expect(actions.onPreview).toHaveBeenCalledOnce();
  expect(actions.onApply).toHaveBeenCalledWith(false);
});

it("keeps Cancel available while processing and displays native progress", () => {
  const actions = callbacks();
  const job = {
    candidate: { sampleRate: 48000, channels: 2, frames: 100, ...view.selection },
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
    phase: "processing" as const,
    phaseIndex: 0,
    phaseCount: 1,
    gainResolved: true,
    inputPeak: 0,
    inputLufs: null,
    predictedLufs: null,
    outputLufs: null,
    planningSteps: 0,
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
    candidate: { sampleRate: 48000, channels: 2, frames: 100, ...view.selection },
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
    phase: "processing" as const,
    phaseIndex: 0,
    phaseCount: 1,
    gainResolved: true,
    inputPeak: 0,
    inputLufs: null,
    predictedLufs: null,
    outputLufs: null,
    planningSteps: 0,
  };
  const ui = render(<ProcessDialog view={{ ...view, phase: "ready", job }} {...actions} />);
  expect(ui.getByRole("alert").textContent).toContain("PCM export may clip");
  fireEvent.click(ui.getByRole("button", { name: "Apply anyway" }));
  expect(actions.onApply).toHaveBeenCalledWith(true);
  ui.rerender(
    <ProcessDialog view={{ ...view, parameterText: "-6", phase: "ready", job }} {...actions} />,
  );
  expect(ui.queryByRole("alert")).toBeNull();
  fireEvent.click(ui.getByRole("button", { name: "Apply" }));
  expect(actions.onApply).toHaveBeenLastCalledWith(false);
});

it("invalid gain disables Preview and Apply but never prevents cancellation", () => {
  const actions = callbacks();
  const ui = render(<ProcessDialog view={{ ...view, parameterText: "Infinity" }} {...actions} />);
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

it("conditional unmount restores focus after the launcher is re-enabled", async () => {
  const actions = callbacks();
  const ui = render(
    <div>
      <button type="button">Launcher</button>
    </div>,
  );
  const opener = ui.getByRole("button", { name: "Launcher" });
  opener.focus();
  opener.blur(); // Lazy loading can finish after the disabled launcher loses focus.
  ui.rerender(
    <div>
      <button type="button" disabled>
        Launcher
      </button>
      <ProcessDialog view={{ ...view, returnFocus: opener }} {...actions} />
    </div>,
  );
  ui.rerender(
    <div>
      <button type="button">Launcher</button>
    </div>,
  );
  await Promise.resolve();
  expect(document.activeElement).toBe(opener);
});

const normalizedJob = (change: Partial<ProcessJobResult> = {}): ProcessJobResult => ({
  candidate: { sampleRate: 48000, channels: 2, frames: 100, ...view.selection },
  ...view.selection,
  documentId: "doc-1",
  jobId: "process-1",
  operation: "normalize-loudness",
  target: -23,
  state: "ready",
  phase: "verifying",
  phaseIndex: 2,
  phaseCount: 3,
  gainDb: 7.5,
  gainResolved: true,
  processedFrames: 20,
  totalFrames: 20,
  inputPeak: 0.1,
  inputLufs: -30.5,
  predictedLufs: -23,
  outputLufs: -23.01,
  peak: 0.25,
  nonFinite: false,
  planningSteps: 0,
  ...change,
});

it("labels typed normalization targets, linked channel scope and mode selection", () => {
  const actions = callbacks();
  const ui = render(
    <ProcessDialog
      view={{ ...view, operation: "normalize-peak", parameterText: "-1" }}
      {...actions}
    />,
  );
  expect(ui.getByRole("dialog", { name: "Normalize" }).textContent).toContain(
    "One linked gain across the selected channels",
  );
  expect(document.activeElement).toBe(ui.getByLabelText("Target peak (dBFS)"));
  fireEvent.change(ui.getByLabelText("Normalization mode"), {
    target: { value: "normalize-loudness" },
  });
  expect(actions.onOperationChange).toHaveBeenCalledWith("normalize-loudness");
  ui.rerender(
    <ProcessDialog
      view={{ ...view, operation: "normalize-loudness", parameterText: "-23" }}
      {...actions}
    />,
  );
  expect(ui.getByLabelText("Target loudness (LUFS)")).toBeDefined();
});

it.each(["analyzing", "processing", "verifying"] as const)(
  "shows truthful %s phase and keeps cancellation available",
  (phase) => {
    const job = normalizedJob({
      state: "running",
      phase,
      phaseIndex: phase === "analyzing" ? 0 : phase === "processing" ? 1 : 2,
      processedFrames: 5,
      gainResolved: phase !== "analyzing",
      gainDb: phase === "analyzing" ? 0 : 7.5,
      peak: phase === "analyzing" ? 0 : 0.25,
      inputLufs: phase === "analyzing" ? null : -30.5,
      predictedLufs: phase === "analyzing" ? null : -23,
      outputLufs: null,
    });
    const ui = render(
      <ProcessDialog
        view={{
          ...view,
          operation: "normalize-loudness",
          parameterText: "-23",
          phase: "processing",
          job,
        }}
        {...callbacks()}
      />,
    );
    expect(ui.getByTestId("process-status").textContent).toBe(
      phase === "analyzing"
        ? "Analyzing…"
        : phase === "verifying"
          ? "Verifying loudness…"
          : "Processing…",
    );
    expect(ui.getByLabelText("Processing progress").getAttribute("value")).toBe("5");
    expect((ui.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);
    expect((ui.getByLabelText("Normalization mode") as HTMLSelectElement).disabled).toBe(true);
    expect(ui.queryByText(/Resolved gain/)).toBeNull();
  },
);

it("distinguishes source reading, certified prediction and actual output measurement", () => {
  const ui = render(
    <ProcessDialog
      view={{
        ...view,
        operation: "normalize-loudness",
        parameterText: "-23",
        phase: "ready",
        job: normalizedJob(),
      }}
      {...callbacks()}
    />,
  );
  expect(ui.getByText("Resolved gain: 7.500 dB")).toBeDefined();
  expect(ui.getByText("Source integrated loudness: -30.50 LUFS")).toBeDefined();
  expect(ui.getByText("Predicted output loudness: -23.00 LUFS")).toBeDefined();
  expect(ui.getByText("Measured output loudness: -23.01 LUFS")).toBeDefined();
});

it("never fabricates loudness for positive below-gate input or silent unchanged output", () => {
  const actions = callbacks();
  const ui = render(
    <ProcessDialog
      view={{
        ...view,
        operation: "normalize-loudness",
        parameterText: "-23",
        phase: "ready",
        job: normalizedJob({ inputLufs: null, outputLufs: null }),
      }}
      {...actions}
    />,
  );
  expect(ui.getByText("Source loudness unavailable: below the absolute gate")).toBeDefined();
  expect(ui.queryByText(/Source integrated loudness/)).toBeNull();
  expect(ui.getByText("Predicted output loudness: -23.00 LUFS")).toBeDefined();
  ui.rerender(
    <ProcessDialog
      view={{
        ...view,
        operation: "normalize-loudness",
        parameterText: "-23",
        phase: "ready",
        job: normalizedJob({
          inputLufs: null,
          predictedLufs: null,
          outputLufs: null,
          inputPeak: 0,
          peak: 0,
          gainResolved: true,
          gainDb: 0,
          unchangedReason: "silent",
        }),
      }}
      {...actions}
    />,
  );
  expect(ui.getByTestId("process-status").textContent).toContain("selected audio is silent");
  expect(ui.getByText("Source loudness unavailable: silence")).toBeDefined();
  expect(ui.queryByText(/Resolved gain|Measured output loudness/)).toBeNull();
  expect(ui.getByRole("dialog").textContent).not.toMatch(/NaN|Infinity/);
});

it("normalization warnings belong to the requested mode/target, not resolved gain", () => {
  const actions = callbacks();
  const job = normalizedJob({ peak: 2 });
  const ui = render(
    <ProcessDialog
      view={{ ...view, operation: "normalize-loudness", parameterText: "-23", phase: "ready", job }}
      {...actions}
    />,
  );
  fireEvent.click(ui.getByRole("button", { name: "Apply anyway" }));
  expect(actions.onApply).toHaveBeenCalledWith(true);
  ui.rerender(
    <ProcessDialog
      view={{ ...view, operation: "normalize-loudness", parameterText: "-24", phase: "ready", job }}
      {...actions}
    />,
  );
  expect(ui.queryByRole("alert")).toBeNull();
  expect(ui.queryByText(/Output sample peak/)).toBeNull();
});

it.each([
  ["normalize-peak", "1", "between −120 and 0 dBFS"],
  ["normalize-loudness", "-70", "between −69 and 0 LUFS"],
] as const)(
  "rejects %s target without stealing cancellation",
  (operation, parameterText, error) => {
    const ui = render(
      <ProcessDialog view={{ ...view, operation, parameterText }} {...callbacks()} />,
    );
    expect(ui.getByRole("alert").textContent).toContain(error);
    expect((ui.getByRole("button", { name: "Preview" }) as HTMLButtonElement).disabled).toBe(true);
    expect((ui.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);
  },
);
