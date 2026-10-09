import type { ProcessJobResult } from "@aae/protocol";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SpeechView } from "@/hooks/use-speech";
import { defaultProcessSettings } from "@/lib/process-settings";
import { emptySpeechForm, speechFormForCatalog } from "@/lib/speech-settings";
import { TEST_SPEECH_CATALOG } from "@/speech/catalog-fixture";
import { SpeechDialog } from "./speech-dialog";

const info = {
  documentId: "doc-1",
  name: "voice.wav",
  sampleRate: 48000,
  channels: 2,
  frames: 96000,
  bitDepth: 16,
  float: false,
};
const form = speechFormForCatalog(emptySpeechForm(5), TEST_SPEECH_CATALOG);
const view: SpeechView = {
  info,
  selection: { start: 48000, end: 48000, channelMask: 3 },
  operation: "generate",
  parameterText: "",
  settings: defaultProcessSettings(info),
  phase: "idle",
  previewing: false,
  form,
  engine: {
    status: "ready",
    catalog: TEST_SPEECH_CATALOG,
    loaded: { model: "german_24l", voices: ["juergen"] },
  },
  current: false,
};
const job = {
  jobId: "speech-1",
  state: "ready",
  peak: 0.5,
  nonFinite: false,
  candidate: {
    sampleRate: 48000,
    channels: 2,
    frames: 96010,
    start: 48000,
    end: 48010,
    channelMask: 3,
  },
} as ProcessJobResult;
const callbacks = () => ({
  onFormChange: vi.fn(),
  onModelChange: vi.fn(),
  onNewSeed: vi.fn(),
  onGenerate: vi.fn(),
  onPreview: vi.fn(),
  onStopPreview: vi.fn(),
  onApply: vi.fn(),
  onRetry: vi.fn(),
  onCancel: vi.fn(),
});
const button = (ui: ReturnType<typeof render>, name: string) =>
  ui.getByRole("button", { name }) as HTMLButtonElement;

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

it("lists models with sizes and load state, voices, placement, counter and credit", () => {
  const actions = callbacks();
  const ui = render(<SpeechDialog view={view} {...actions} />);
  expect(ui.getByRole("dialog", { name: "Generate speech" })).toBeTruthy();
  expect(document.activeElement).toBe(ui.getByLabelText("Text"));
  const models = [...ui.getByLabelText("Model").querySelectorAll("option")].map(
    (option) => option.textContent,
  );
  expect(models).toEqual(["English (Jan 2026) · 1 KiB", "German, 24 layers · 3.9 KiB · loaded"]);
  expect([...ui.getByLabelText("Voice").querySelectorAll("option")].map((o) => o.value)).toEqual([
    "alba",
    "marius",
  ]);
  expect(ui.getByTestId("speech-placement").textContent).toBe(
    "Inserts at 0:01.000 (both channels)",
  );
  expect(ui.getByTestId("speech-text-length").textContent).toBe("12 / 5,000");
  expect(ui.getByRole("link", { name: "Kyutai PocketTTS" }).getAttribute("href")).toBe(
    "https://huggingface.co/kyutai/pocket-tts",
  );
  expect(ui.getByText(/weights CC-BY-4.0/)).toBeTruthy();
  expect(ui.getByTestId("speech-status").textContent).toBe("Ready to generate");
  expect(button(ui, "Generate").disabled).toBe(false);
  expect(button(ui, "Preview").disabled).toBe(true);
  expect(button(ui, "Apply").disabled).toBe(true);
  fireEvent.click(button(ui, "Generate"));
  expect(actions.onGenerate).toHaveBeenCalled();
  fireEvent.change(ui.getByLabelText("Model"), { target: { value: "german_24l" } });
  expect(actions.onModelChange).toHaveBeenCalledWith("german_24l");
  fireEvent.change(ui.getByLabelText("Text"), { target: { value: "Hi" } });
  expect(actions.onFormChange).toHaveBeenCalledWith({ text: "Hi" });
});

it("validates text and advanced settings before Generate", () => {
  const actions = callbacks();
  const ui = render(
    <SpeechDialog view={{ ...view, form: { ...form, text: "𝔸".repeat(5001) } }} {...actions} />,
  );
  expect(ui.getByTestId("speech-text-length").textContent).toBe("5,001 / 5,000");
  expect(ui.getByRole("alert").textContent).toMatch(/up to 5,000 characters/);
  expect(button(ui, "Generate").disabled).toBe(true);
  ui.rerender(
    <SpeechDialog view={{ ...view, form: { ...form, samplerStepsText: "65" } }} {...actions} />,
  );
  expect(ui.getByRole("alert").textContent).toMatch(/Sampler steps/);
  expect(ui.getByLabelText("Sampler steps").getAttribute("aria-invalid")).toBe("true");
  fireEvent.change(ui.getByLabelText("Temperature"), { target: { value: "0.7" } });
  expect(actions.onFormChange).toHaveBeenCalledWith({ temperatureText: "0.7" });
  fireEvent.click(button(ui, "New seed"));
  expect(actions.onNewSeed).toHaveBeenCalled();
});

it("shows each stage while generating and blocks every action but Cancel", () => {
  const actions = callbacks();
  const working = { ...view, phase: "processing" as const };
  const ui = render(
    <SpeechDialog
      view={{
        ...working,
        activity: { stage: "download", path: "x", done: 25, total: 100 },
      }}
      {...actions}
    />,
  );
  expect(ui.getByTestId("speech-status").textContent).toBe("Downloading model… 25%");
  expect(ui.getByRole("progressbar", { name: "Speech progress" })).toBeTruthy();
  for (const name of ["Generate", "Preview", "Apply"]) expect(button(ui, name).disabled).toBe(true);
  expect(button(ui, "Cancel").disabled).toBe(false);
  expect((ui.getByLabelText("Text") as HTMLTextAreaElement).disabled).toBe(true);
  for (const [activity, text] of [
    [{ stage: "load" }, "Loading model…"],
    [{ stage: "read", path: "x", done: 1, total: 2 }, "Reading model… 50%"],
    [{ stage: "synthesize", chunk: 2, chunks: 3, step: 1, maxSteps: 10 }, "Sentence 2 of 3"],
    [{ stage: "start" }, "Starting the speech engine…"],
  ] as const) {
    ui.rerender(<SpeechDialog view={{ ...working, activity }} {...actions} />);
    expect(ui.getByTestId("speech-status").textContent).toBe(text);
  }
  ui.rerender(
    <SpeechDialog view={{ ...working, activity: { stage: "place" }, job }} {...actions} />,
  );
  expect(ui.getByTestId("speech-status").textContent).toBe("Placing speech…");
  fireEvent.click(button(ui, "Cancel"));
  expect(actions.onCancel).toHaveBeenCalled();
});

it("enables Preview and Apply for a current candidate and asks to Apply anyway when it clips", () => {
  const actions = callbacks();
  const ui = render(
    <SpeechDialog view={{ ...view, phase: "ready", job, current: true }} {...actions} />,
  );
  expect(ui.getByTestId("speech-status").textContent).toBe("Speech ready");
  fireEvent.click(button(ui, "Preview"));
  expect(actions.onPreview).toHaveBeenCalled();
  fireEvent.click(button(ui, "Apply"));
  expect(actions.onApply).toHaveBeenCalledWith(false);
  ui.rerender(
    <SpeechDialog
      view={{ ...view, phase: "ready", job, current: true, previewing: true }}
      {...actions}
    />,
  );
  fireEvent.click(button(ui, "Stop preview"));
  expect(actions.onStopPreview).toHaveBeenCalled();
  ui.rerender(
    <SpeechDialog
      view={{ ...view, phase: "ready", job: { ...job, peak: 1.5 }, current: true }}
      {...actions}
    />,
  );
  fireEvent.click(button(ui, "Apply anyway"));
  expect(actions.onApply).toHaveBeenLastCalledWith(true);
  ui.rerender(
    <SpeechDialog view={{ ...view, phase: "ready", job, current: false }} {...actions} />,
  );
  expect(ui.getByTestId("speech-status").textContent).toMatch(/Generate again/);
  expect(button(ui, "Apply").disabled).toBe(true);
});

it("shows errors inline with Retry, including an engine that cannot start", () => {
  const actions = callbacks();
  const ui = render(
    <SpeechDialog
      view={{ ...view, error: { message: "Download failed: 503", stopped: false } }}
      {...actions}
    />,
  );
  expect(ui.getByRole("alert").textContent).toMatch(/Download failed: 503/);
  fireEvent.click(button(ui, "Retry"));
  expect(actions.onRetry).toHaveBeenCalledTimes(1);
  ui.rerender(
    <SpeechDialog view={{ ...view, engine: { status: "failed", error: "404" } }} {...actions} />,
  );
  expect(ui.getByRole("alert").textContent).toMatch(/could not start: 404/);
  expect(button(ui, "Generate").disabled).toBe(true);
  fireEvent.click(button(ui, "Retry"));
  expect(actions.onRetry).toHaveBeenCalledTimes(2);
  ui.rerender(<SpeechDialog view={{ ...view, engine: { status: "starting" } }} {...actions} />);
  expect(ui.getByText("Starting the speech engine…")).toBeTruthy();
  expect((ui.getByLabelText("Model") as HTMLSelectElement).disabled).toBe(true);
});

it("describes replacement of a channel selection and an empty document", () => {
  const ui = render(
    <SpeechDialog
      view={{ ...view, selection: { start: 0, end: 48000, channelMask: 2 } }}
      {...callbacks()}
    />,
  );
  expect(ui.getByTestId("speech-placement").textContent).toBe("Replaces 0:00.000–0:01.000 (right)");
  ui.rerender(
    <SpeechDialog
      view={{
        ...view,
        info: { ...info, frames: 0 },
        selection: { start: 0, end: 0, channelMask: 3 },
      }}
      {...callbacks()}
    />,
  );
  expect(ui.getByTestId("speech-placement").textContent).toBe(
    "Creates audio in the empty document",
  );
});

it("cancels on Escape unless committing", () => {
  const actions = callbacks();
  const ui = render(<SpeechDialog view={view} {...actions} />);
  fireEvent(ui.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(actions.onCancel).toHaveBeenCalledTimes(1);
  ui.rerender(<SpeechDialog view={{ ...view, phase: "committing" }} {...actions} />);
  fireEvent(ui.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(actions.onCancel).toHaveBeenCalledTimes(1);
});
