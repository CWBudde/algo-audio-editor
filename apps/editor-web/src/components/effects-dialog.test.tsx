import type { EffectDescriptor } from "@aae/protocol";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EffectsView } from "@/hooks/use-effects";
import { EffectsDialog } from "./effects-dialog";

const descriptor: EffectDescriptor = {
  id: "distortion",
  name: "Distortion",
  category: "Distortion",
  channelMode: "mono",
  view: "generic",
  parameters: [
    {
      id: "drive",
      label: "Drive",
      unit: "",
      type: "number",
      min: 0.1,
      max: 10,
      default: 1,
      scale: "log",
      step: 0.01,
    },
    {
      id: "mode",
      label: "Mode",
      unit: "",
      type: "enum",
      min: 0,
      max: 0,
      default: 0,
      defaultString: "soft",
      scale: "lin",
      step: 0,
      options: [
        { value: "soft", label: "Soft" },
        { value: "hard", label: "Hard" },
      ],
    },
    {
      id: "invert",
      label: "Invert",
      unit: "",
      type: "boolean",
      min: 0,
      max: 1,
      default: 0,
      scale: "lin",
      step: 1,
    },
  ],
  presets: [{ id: "warm", name: "Warm", num: { drive: 2, invert: 0 }, str: { mode: "soft" } }],
};
const view: EffectsView = {
  info: {
    documentId: "doc-1",
    name: "audio.wav",
    sampleRate: 48000,
    channels: 2,
    frames: 100,
    bitDepth: 32,
    float: true,
  },
  selection: { start: 10, end: 30, channelMask: 2 },
  rack: [{ id: "fx-1", type: "distortion", params: { drive: 1, mode: "soft", invert: 0 } }],
  wet: 1,
  bypass: false,
  phase: "idle",
  previewing: false,
};
const callbacks = () => ({
  onChange: vi.fn(),
  onPreview: vi.fn(),
  onStopPreview: vi.fn(),
  onApply: vi.fn(),
  onCancel: vi.fn(),
  onLoadIR: vi.fn(),
  onSavePreset: vi.fn(),
  onDeletePreset: vi.fn(),
  onLoadPreset: vi.fn(),
});
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
it("generates accessible numeric/knob/enum/boolean controls and applies factory presets", () => {
  const actions = callbacks();
  const ui = render(
    <EffectsDialog view={view} descriptors={[descriptor]} presets={[]} {...actions} />,
  );
  expect(ui.getByRole("dialog", { name: "Effects rack" })).toBeTruthy();
  expect(ui.getByRole("slider", { name: "Drive knob" })).toBeTruthy();
  fireEvent.change(ui.getByLabelText("Drive"), { target: { value: "3" } });
  expect(actions.onChange).toHaveBeenCalledWith(
    expect.objectContaining({
      rack: [expect.objectContaining({ params: expect.objectContaining({ drive: 3 }) })],
    }),
  );
  fireEvent.change(ui.getByLabelText("Mode"), { target: { value: "hard" } });
  expect(actions.onChange).toHaveBeenCalledWith(
    expect.objectContaining({
      rack: [expect.objectContaining({ params: expect.objectContaining({ mode: "hard" }) })],
    }),
  );
  fireEvent.click(ui.getByLabelText("Invert"));
  expect(actions.onChange).toHaveBeenCalledWith(
    expect.objectContaining({
      rack: [expect.objectContaining({ params: expect.objectContaining({ invert: 1 }) })],
    }),
  );
  fireEvent.change(ui.getByLabelText("Factory preset"), { target: { value: "warm" } });
  expect(actions.onChange).toHaveBeenCalledWith({
    rack: [{ ...view.rack[0], params: { drive: 2, mode: "soft", invert: 0 } }],
  });
});
it("reorders the rack and routes bypass/wet without hidden sample processing", () => {
  const actions = callbacks();
  const second = { ...view.rack[0], id: "fx-2" };
  const ui = render(
    <EffectsDialog
      view={{ ...view, rack: [...view.rack, second] }}
      descriptors={[descriptor]}
      presets={[]}
      {...actions}
    />,
  );
  fireEvent.click(ui.getAllByRole("button", { name: "Move Distortion up" })[1]);
  expect(actions.onChange).toHaveBeenCalledWith({ rack: [second, view.rack[0]] });
  fireEvent.click(ui.getByLabelText("Bypass rack"));
  expect(actions.onChange).toHaveBeenCalledWith({ bypass: true });
  fireEvent.change(ui.getByLabelText("Wet/dry"), { target: { value: "25" } });
  expect(actions.onChange).toHaveBeenCalledWith({ wet: 0.25 });
});
it("allows Escape during bounded offline render but fences cancellation during authoritative commit", () => {
  const actions = callbacks();
  const ui = render(
    <EffectsDialog
      view={{ ...view, phase: "applying" }}
      descriptors={[descriptor]}
      presets={[]}
      {...actions}
    />,
  );
  fireEvent(ui.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(actions.onCancel).toHaveBeenCalledOnce();
  ui.rerender(
    <EffectsDialog
      view={{ ...view, phase: "committing" }}
      descriptors={[descriptor]}
      presets={[]}
      {...actions}
    />,
  );
  fireEvent(ui.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(actions.onCancel).toHaveBeenCalledOnce();
  expect((ui.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
});
it("switching the Filter family to Moog keeps only parameters the Moog node declares", () => {
  const parameter = (id: string, label: string, options?: string[]) => ({
    id,
    label,
    unit: "",
    type: options ? ("enum" as const) : ("number" as const),
    min: 0,
    max: options ? 0 : 20000,
    default: options ? 0 : 1000,
    defaultString: options?.[0],
    scale: "lin" as const,
    step: options ? 0 : 1,
    options: options?.map((value) => ({ value, label: value })),
  });
  const shared = [
    parameter("kind", "Kind", ["lowpass", "highpass"]),
    parameter("family", "Family", ["rbj", "chebyshev2", "moog"]),
    parameter("freq", "Cutoff"),
    parameter("q", "Q"),
    parameter("order", "Order"),
  ];
  const filter: EffectDescriptor = {
    id: "filter",
    name: "Filter",
    category: "EQ",
    channelMode: "mono",
    view: "generic",
    parameters: [...shared, parameter("stopbandDB", "Stopband"), parameter("rippleDB", "Ripple")],
    presets: [],
  };
  const moog: EffectDescriptor = { ...filter, id: "filter-moog", name: "Moog", parameters: shared };
  const actions = callbacks();
  const params = {
    kind: "lowpass",
    family: "chebyshev2",
    freq: 1000,
    q: 1,
    order: 4,
    stopbandDB: 40,
    rippleDB: 1,
  };
  const ui = render(
    <EffectsDialog
      view={{ ...view, rack: [{ id: "fx-1", type: "filter", params }] }}
      descriptors={[filter, moog]}
      presets={[]}
      {...actions}
    />,
  );
  fireEvent.change(ui.getByLabelText("Family"), { target: { value: "moog" } });
  const node = actions.onChange.mock.lastCall?.[0].rack[0];
  expect(node.type).toBe("filter-moog");
  expect(Object.keys(node.params).sort()).toEqual(["family", "freq", "kind", "order", "q"]);
  expect(node.params.family).toBe("moog");
});
