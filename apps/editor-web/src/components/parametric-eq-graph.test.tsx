import type { EffectDescriptor, EffectParameterDescriptor } from "@aae/protocol";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RackEffect } from "@/lib/effect-presets";
import { EffectParameters } from "./effect-parameters";
import { ParametricEQGraph } from "./parametric-eq-graph";

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
  vi.restoreAllMocks();
});
const numeric = (
  id: string,
  value: number,
  min: number,
  max: number,
): EffectParameterDescriptor => ({
  id,
  label: id,
  type: "number",
  unit: "",
  min,
  max,
  default: value,
  scale: "lin",
  step: 0,
});
const descriptor: EffectDescriptor = {
  id: "eq-parametric",
  name: "Parametric EQ",
  category: "EQ",
  channelMode: "mono",
  view: "eq",
  presets: [],
  parameters: [
    numeric("bands", 2, 1, 8),
    ...Array.from({ length: 8 }, (_, index) => [
      numeric(`band${index + 1}FreqHz`, (index + 1) * 1000, 20, 23520),
      numeric(`band${index + 1}GainDB`, 0, -24, 24),
      numeric(`band${index + 1}Q`, 1, 0.2, 8),
    ]).flat(),
  ],
};
const initial: RackEffect = {
  id: "eq",
  type: "eq-parametric",
  params: Object.fromEntries(
    descriptor.parameters.map((parameter) => [parameter.id, parameter.default]),
  ),
};
const base = {
  descriptor,
  node: initial,
  points: [
    [20, 0],
    [1000, 6],
    [20000, 0],
  ] as [number, number][],
  sampleRate: 48000,
  disabled: false,
};

function setup(svg: Element) {
  const node = svg as SVGSVGElement;
  node.setPointerCapture = vi.fn();
  node.hasPointerCapture = () => true;
  node.releasePointerCapture = vi.fn();
  vi.spyOn(node, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 640,
    bottom: 280,
    width: 640,
    height: 280,
    toJSON() {},
  });
  return node;
}

it("draws supplied kernel points against labeled logarithmic axes and shows only active bands", () => {
  const view = render(<ParametricEQGraph {...base} onChange={vi.fn()} />);
  expect(view.getByText("Frequency (Hz)")).toBeTruthy();
  expect(view.getByText("Gain (dB)")).toBeTruthy();
  expect(view.getByText("20k")).toBeTruthy();
  expect(view.getByRole("img", { name: "Parametric EQ response curve" })).toBeTruthy();
  expect(view.getAllByRole("slider")).toHaveLength(2);
  expect(view.getByTestId("effect-response-path").getAttribute("d")).toMatch(
    /^M52,125 L[\d.]+,98.75 L620,125$/,
  );
  view.rerender(
    <EffectParameters
      descriptor={descriptor}
      node={initial}
      sampleRate={48000}
      disabled={false}
      onChange={vi.fn()}
    />,
  );
  expect(view.getByLabelText("band2GainDB")).toBeTruthy();
  expect(view.queryByLabelText("band3GainDB")).toBeNull();
});

it("keeps the grabbed band through crossings, clamps outside drags and ignores other pointers/canceled work", () => {
  const onChange = vi.fn();
  function Controlled() {
    const [params, setParams] = useState(initial.params);
    return (
      <ParametricEQGraph
        {...base}
        node={{ ...initial, params }}
        onChange={(next) => {
          onChange(next);
          setParams(next);
        }}
      />
    );
  }
  const view = render(<Controlled />);
  const svg = setup(view.getByRole("group"));
  const band = view.getByRole("slider", { name: "EQ band 1" });
  fireEvent.pointerDown(band, {
    clientX: Number(band.getAttribute("cx")),
    clientY: 125,
    button: 0,
  });
  fireEvent.pointerMove(svg, { clientX: 600, clientY: 80, pointerId: 2 });
  expect(onChange).toHaveBeenCalledTimes(1);
  fireEvent.pointerMove(svg, { clientX: 600, clientY: 80 });
  expect(onChange.mock.lastCall?.[0].band1FreqHz).toBeGreaterThan(15000);
  expect(onChange.mock.lastCall?.[0].band2FreqHz).toBe(2000);
  fireEvent.pointerMove(svg, { clientX: 900, clientY: -100 });
  expect(onChange.mock.lastCall?.[0]).toMatchObject({
    band1FreqHz: 20000,
    band1GainDB: 24,
    band2GainDB: 0,
  });
  fireEvent.pointerCancel(svg);
  onChange.mockClear();
  fireEvent.pointerMove(svg, { clientX: 200, clientY: 200 });
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.pointerDown(svg, { clientX: 10, clientY: 10, button: 0 });
  fireEvent.pointerDown(svg, { clientX: 200, clientY: 100, button: 2 });
  expect(onChange).not.toHaveBeenCalled();
});

it("provides independent keyboard frequency/gain/Q controls, fine steps and reset", () => {
  const onChange = vi.fn();
  const view = render(<ParametricEQGraph {...base} onChange={onChange} />);
  const band = view.getByRole("slider", { name: "EQ band 2" });
  fireEvent.focus(band);
  fireEvent.keyDown(band, { key: "ArrowRight" });
  expect(onChange.mock.lastCall?.[0].band2FreqHz).toBeCloseTo(2000 * 2 ** (1 / 12));
  fireEvent.keyDown(band, { key: "ArrowUp", shiftKey: true });
  expect(onChange.mock.lastCall?.[0]).toMatchObject({ band2GainDB: 0.1, band1GainDB: 0 });
  fireEvent.keyDown(band, { key: "+" });
  expect(onChange.mock.lastCall?.[0].band2Q).toBe(1.1);
  fireEvent.keyDown(band, { key: "Home" });
  expect(onChange.mock.lastCall?.[0].band2GainDB).toBe(0);
  view.rerender(<ParametricEQGraph {...base} disabled onChange={onChange} />);
  onChange.mockClear();
  expect(band.getAttribute("tabindex")).toBe("-1");
  fireEvent.keyDown(band, { key: "ArrowUp" });
  const svg = setup(view.getByRole("group"));
  fireEvent.pointerDown(svg, { clientX: 200, clientY: 100, button: 0 });
  expect(onChange).not.toHaveBeenCalled();
});

it("limits the graph to the sample rate and retains hidden bands for later reactivation", () => {
  const onChange = vi.fn();
  const view = render(<ParametricEQGraph {...base} sampleRate={16000} onChange={onChange} />);
  expect(view.getByText("7.84k")).toBeTruthy();
  expect(view.queryByText("20k")).toBeNull();
  fireEvent.focus(view.getByRole("slider", { name: "EQ band 2" }));
  view.rerender(
    <ParametricEQGraph
      {...base}
      node={{ ...initial, params: { ...initial.params, bands: 1 } }}
      sampleRate={16000}
      onChange={onChange}
    />,
  );
  expect(view.getAllByRole("slider")).toHaveLength(1);
  expect(view.getByText("Band 1")).toBeTruthy();
  fireEvent.keyDown(view.getByRole("slider"), { key: "ArrowUp" });
  expect(onChange.mock.lastCall?.[0].band8FreqHz).toBe(8000);
});
