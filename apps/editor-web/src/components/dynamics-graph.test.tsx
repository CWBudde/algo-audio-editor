import type { EffectDescriptor } from "@aae/protocol";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { KernelClient } from "@/kernel/client";
import { DynamicsGraph } from "./dynamics-graph";
import { EffectParameters } from "./effect-parameters";

beforeEach(() => vi.stubGlobal("PointerEvent", MouseEvent));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const descriptor: EffectDescriptor = {
  id: "dyn-compressor",
  name: "Compressor",
  category: "Dynamics",
  channelMode: "mono",
  view: "dynamics",
  presets: [],
  parameters: [],
};
const node = { id: "compressor", type: descriptor.id, params: { thresholdDB: -20, kneeDB: 8 } };
const points: [number, number][] = [
  [-80, -120],
  [-40, -40],
  [-20, -20],
  [0, -15],
];
const props = { descriptor, node, points, disabled: false };

it("plots supplied outputs without a frontend dynamics formula, with unity, threshold and knee guides", () => {
  const ui = render(<DynamicsGraph {...props} />);
  expect(ui.getByText("Input (dB)")).toBeTruthy();
  expect(ui.getByText("Output (dB)")).toBeTruthy();
  expect(ui.getByText("Threshold -20.0 dB · Knee +8.0 dB")).toBeTruthy();
  expect(ui.getByTestId("dynamics-threshold").getAttribute("x1")).toBe("481");
  expect(Number(ui.getByTestId("dynamics-knee").getAttribute("width"))).toBeCloseTo(55.6);
  expect(ui.getByTestId("dynamics-unity").getAttribute("d")).toBe(
    `M64,264 L620,${28 + (24 * 236) / 104}`,
  );
  expect(ui.getByTestId("effect-response-path").getAttribute("d")).toBe(
    points
      .map(
        ([input, output], index) =>
          `${index ? "L" : "M"}${64 + ((input + 80) * 556) / 80},${28 + ((24 - output) * 236) / 104}`,
      )
      .join(" "),
  );
  // Values below the visible axis are clipped by SVG, but retained verbatim for inspection.
  fireEvent.change(ui.getByRole("slider"), { target: { value: "0" } });
  expect(ui.getByRole("status").textContent).toBe(
    "Input -80.0 dB → Output -120.0 dB · Gain change -40.0 dB",
  );
});

it("inspects nearest kernel samples by pointer/touch or accessible slider without editing parameters", () => {
  const ui = render(<DynamicsGraph {...props} />);
  const svg = ui.getByRole("img");
  vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
    x: 100,
    y: 50,
    left: 100,
    top: 50,
    right: 420,
    bottom: 210,
    width: 320,
    height: 160,
    toJSON() {},
  });
  fireEvent.pointerMove(svg, { clientX: 271, clientY: 100 });
  expect(ui.getByRole("status").textContent).toBe(
    "Input -40.0 dB → Output -40.0 dB · Gain change 0.0 dB",
  );
  fireEvent.pointerMove(svg, { clientX: 101, clientY: 51 });
  expect(ui.getByRole("slider").getAttribute("aria-valuetext")).toBe(
    "-40.0 dB input, -40.0 dB output",
  );
  fireEvent.pointerDown(svg, { clientX: 410, clientY: 100 });
  expect(ui.getByRole("status").textContent).toContain("Input 0.0 dB → Output -15.0 dB");
  fireEvent.change(ui.getByLabelText("Read input level"), { target: { value: "2" } });
  expect(ui.getByRole("status").textContent).toContain("Input -20.0 dB → Output -20.0 dB");
  expect(node.params).toEqual({ thresholdDB: -20, kneeDB: 8 });
  ui.rerender(<DynamicsGraph {...props} disabled />);
  expect(ui.getByRole("slider")).toHaveProperty("disabled", true);
  fireEvent.pointerMove(svg, { clientX: 410, clientY: 100 });
  expect(ui.getByRole("status").textContent).toContain("Input -20.0 dB");
});

it("retains the inspected input across response updates and handles hard knees, makeup gain and loading", () => {
  const ui = render(<DynamicsGraph {...props} />);
  fireEvent.change(ui.getByRole("slider"), { target: { value: "3" } });
  ui.rerender(
    <DynamicsGraph
      {...props}
      node={{ ...node, params: { thresholdDB: -10, kneeDB: 0 } }}
      points={[
        [-80, -80],
        [-30, -30],
        [0, 12],
      ]}
    />,
  );
  expect(ui.queryByTestId("dynamics-knee")).toBeNull();
  expect(ui.getByRole("status").textContent).toBe(
    "Input 0.0 dB → Output +12.0 dB · Gain change +12.0 dB",
  );
  expect(ui.getByRole("slider")).toHaveProperty("value", "2");
  ui.rerender(<DynamicsGraph {...props} points={[]} />);
  expect(ui.getByRole("status").textContent).toBe("Loading transfer curve…");
  expect(ui.getByRole("slider")).toHaveProperty("disabled", true);
});

it("requests binary transfer data and replaces it after parameter changes, ignoring obsolete replies", async () => {
  vi.useFakeTimers();
  let resolveOld: (value: unknown) => void = () => {};
  const call = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValue({ count: 2, data: new Float64Array([-80, -80, 0, -10]).buffer });
  const properties = {
    descriptor,
    node,
    disabled: false,
    sampleRate: 48000,
    client: { call } as unknown as KernelClient,
    onChange: vi.fn(),
  };
  const ui = render(<EffectParameters {...properties} />);
  await act(async () => vi.advanceTimersByTime(25));
  expect(call).toHaveBeenCalledWith("effects.response", {
    effectId: descriptor.id,
    params: node.params,
    sampleRate: 48000,
    points: 256,
    mode: "transfer",
  });
  ui.rerender(
    <EffectParameters
      {...properties}
      node={{ ...node, params: { thresholdDB: -10, kneeDB: 0 } }}
    />,
  );
  await act(async () => vi.advanceTimersByTime(25));
  fireEvent.change(ui.getByLabelText("Read input level"), { target: { value: "1" } });
  expect(ui.getByRole("status").textContent).toContain("Output -10.0 dB");
  const current = ui.getByTestId("effect-response-path").getAttribute("d");
  await act(async () => resolveOld({ count: 2, data: new Float64Array([-80, 0, 0, 24]).buffer }));
  expect(ui.getByTestId("effect-response-path").getAttribute("d")).toBe(current);
  call.mockRejectedValueOnce(new Error("Transfer unavailable"));
  ui.rerender(
    <EffectParameters
      {...properties}
      node={{ ...node, params: { thresholdDB: -30, kneeDB: 0 } }}
    />,
  );
  await act(async () => vi.advanceTimersByTime(25));
  expect(ui.getByRole("alert").textContent).toContain("Transfer unavailable");
});
