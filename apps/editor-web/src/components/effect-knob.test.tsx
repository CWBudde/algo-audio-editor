import type { EffectParameterDescriptor } from "@aae/protocol";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EffectKnob } from "./effect-knob";
import { EffectParameters } from "./effect-parameters";

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, options: MouseEventInit & { pointerId?: number } = {}) {
    super(type, options);
    this.pointerId = options.pointerId ?? 1;
  }
}
beforeEach(() => vi.stubGlobal("PointerEvent", TestPointerEvent));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const parameter: EffectParameterDescriptor = {
  id: "gain",
  label: "Gain",
  unit: "dB",
  type: "number",
  min: -24,
  max: 24,
  default: 0,
  scale: "lin",
  step: 0.1,
};
const props = { parameter, value: 0, disabled: false };

it("captures knob dragging, retains pointer ownership, clamps and stops after cancellation", () => {
  const onChange = vi.fn();
  const view = render(<EffectKnob {...props} onChange={onChange} />);
  const knob = view.getByRole("slider", { name: "Gain knob" });
  knob.setPointerCapture = vi.fn();
  knob.hasPointerCapture = () => true;
  knob.releasePointerCapture = vi.fn();
  fireEvent.pointerDown(knob, { button: 2 });
  fireEvent.pointerMove(knob, { clientY: -40 });
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.pointerDown(knob, { button: 0, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(knob, { clientX: 100, clientY: 60, pointerId: 2 });
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.pointerMove(knob, { clientX: 100, clientY: 60 });
  expect(onChange).toHaveBeenLastCalledWith(12);
  fireEvent.pointerMove(knob, { clientX: 100, clientY: 60, shiftKey: true });
  expect(onChange).toHaveBeenLastCalledWith(12);
  fireEvent.pointerMove(knob, { clientX: 100, clientY: 20, shiftKey: true });
  expect(onChange).toHaveBeenLastCalledWith(13.2);
  fireEvent.pointerMove(knob, { clientX: 100, clientY: -1000 });
  expect(onChange).toHaveBeenLastCalledWith(24);
  fireEvent.pointerCancel(knob);
  onChange.mockClear();
  fireEvent.pointerMove(knob, { clientY: 0 });
  expect(onChange).not.toHaveBeenCalled();
});

it("supports keyboard endpoints/steps, reset, logarithmic values and disabled controls", () => {
  const onChange = vi.fn();
  const view = render(<EffectKnob {...props} onChange={onChange} />);
  const knob = view.getByRole("slider");
  fireEvent.keyDown(knob, { key: "ArrowUp" });
  expect(onChange).toHaveBeenLastCalledWith(0.5);
  fireEvent.keyDown(knob, { key: "ArrowUp", shiftKey: true });
  expect(onChange).toHaveBeenLastCalledWith(0.1);
  fireEvent.keyDown(knob, { key: "Home" });
  expect(onChange).toHaveBeenLastCalledWith(-24);
  fireEvent.keyDown(knob, { key: "End" });
  expect(onChange).toHaveBeenLastCalledWith(24);
  fireEvent.doubleClick(knob);
  expect(onChange).toHaveBeenLastCalledWith(0);
  view.rerender(
    <EffectKnob
      {...props}
      parameter={{ ...parameter, min: 20, max: 20000, scale: "log", step: 0 }}
      value={Math.sqrt(20 * 20000)}
      onChange={onChange}
    />,
  );
  fireEvent.keyDown(knob, { key: "PageUp" });
  expect(onChange.mock.lastCall?.[0]).toBeCloseTo(20 * 1000 ** 0.6, 3);
  view.rerender(<EffectKnob {...props} disabled onChange={onChange} />);
  onChange.mockClear();
  expect(knob.getAttribute("tabindex")).toBe("-1");
  fireEvent.keyDown(knob, { key: "End" });
  fireEvent.doubleClick(knob);
  fireEvent.pointerDown(knob, { button: 0 });
  fireEvent.pointerMove(knob, { clientY: -40 });
  expect(onChange).not.toHaveBeenCalled();
});

it("keeps editable values and visible units below the knob, and propagates incomplete edits for validation", () => {
  const onChange = vi.fn();
  const view = render(
    <EffectParameters
      descriptor={{
        id: "gain",
        name: "Gain",
        category: "Color",
        view: "generic",
        channelMode: "mono",
        parameters: [parameter],
        presets: [],
      }}
      node={{ id: "gain", type: "gain", params: { gain: 0 } }}
      sampleRate={48000}
      disabled={false}
      onChange={onChange}
    />,
  );
  expect(view.getByText("dB")).toBeTruthy();
  const input = view.getByRole("spinbutton", { name: "Gain (dB)" });
  fireEvent.change(input, { target: { value: "-3.5" } });
  expect(onChange).toHaveBeenLastCalledWith({ gain: -3.5 });
  fireEvent.change(input, { target: { value: "" } });
  expect(onChange.mock.lastCall?.[0].gain).toBeNaN();
});
