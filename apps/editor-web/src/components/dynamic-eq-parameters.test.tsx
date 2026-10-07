import type { EffectDescriptor, EffectParameterDescriptor } from "@aae/protocol";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { KernelClient } from "@/kernel/client";
import { createRackEffect } from "@/lib/effect-rack";
import { EffectParameters } from "./effect-parameters";

const number = (
  id: string,
  value: number,
  min: number,
  max: number,
): EffectParameterDescriptor => ({
  id,
  label: id,
  type: "number",
  unit: id.endsWith("Hz") ? "Hz" : id.endsWith("Ms") ? "ms" : id.endsWith("DB") ? "dB" : "",
  min,
  max,
  default: value,
  step: 0,
  scale: "lin",
});
const descriptor: EffectDescriptor = {
  id: "dyn-eq",
  name: "Dynamic EQ",
  category: "Dynamics",
  view: "eq",
  channelMode: "mono",
  presets: [],
  parameters: [
    number("bands", 3, 1, 8),
    number("responseBand", 0, 0, 7),
    ...Array.from({ length: 8 }, (_, index) => {
      const prefix = `band${index + 1}`;
      return [
        number(`${prefix}FreqHz`, [120, 1000, 8000, 60, 350, 2500, 14000, 18000][index], 20, 23520),
        number(`${prefix}GainDB`, 0, -24, 24),
        number(`${prefix}Q`, 1, 0.2, 8),
        number(`${prefix}ThresholdDB`, -24, -80, 0),
        number(`${prefix}Ratio`, 2, 1, 20),
        number(`${prefix}KneeDB`, 6, 0, 24),
        number(`${prefix}RangeDB`, 12, 0, 24),
        number(`${prefix}AttackMs`, 10, 0.1, 1000),
        number(`${prefix}ReleaseMs`, 100, 1, 5000),
        {
          ...number(`${prefix}Type`, 0, 0, 0),
          type: "enum" as const,
          defaultString: "peak",
          options: ["peak", "lowshelf", "highshelf"].map((value) => ({ value, label: value })),
        },
        {
          ...number(`${prefix}Mode`, 0, 0, 0),
          type: "enum" as const,
          defaultString: "downward",
          options: ["static", "downward", "upward", "upward-below"].map((value) => ({
            value,
            label: value,
          })),
        },
      ];
    }).flat(),
  ],
};
beforeEach(() =>
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  ),
);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("requests the EQ snapshot and each actual band transfer without exposing response selection as a control", async () => {
  vi.useFakeTimers();
  const node = createRackEffect(descriptor);
  const call = vi
    .fn()
    .mockResolvedValue({ count: 2, data: new Float64Array([20, 0, 20000, 0]).buffer });
  const ui = render(
    <EffectParameters
      {...{ descriptor, node }}
      disabled={false}
      sampleRate={48000}
      client={{ call } as unknown as KernelClient}
      onChange={vi.fn()}
    />,
  );
  await act(async () => vi.advanceTimersByTime(50));
  expect(call).toHaveBeenCalledTimes(4);
  expect(call).toHaveBeenCalledWith("effects.response", {
    effectId: "dyn-eq",
    mode: "frequency",
    sampleRate: 48000,
    points: 256,
    params: node.params,
  });
  for (let responseBand = 0; responseBand < 3; responseBand++) {
    expect(call).toHaveBeenCalledWith("effects.response", {
      effectId: "dyn-eq",
      mode: "transfer",
      sampleRate: 48000,
      points: 256,
      params: { ...node.params, responseBand },
    });
    const graph = ui.getByRole("img", { name: `Band ${responseBand + 1} dynamics response curve` });
    expect(graph.getAttribute("viewBox")).toBe("0 0 128 128");
    const plot = graph.querySelector("clipPath rect");
    expect(plot?.getAttribute("width")).toBe(plot?.getAttribute("height"));
  }
  expect(ui.getAllByRole("spinbutton")).toHaveLength(27);
  expect(ui.queryByLabelText("responseBand")).toBeNull();
  expect(ui.queryByText(/Order/)).toBeNull();
  expect(ui.getByRole("group", { name: "Dynamic EQ frequency graph" })).toBeTruthy();
});

it("edits frequency/gain/Q and type through the shared graph and preserves independent hidden band settings", async () => {
  let node = createRackEffect(descriptor);
  const onChange = vi.fn();
  const props = { descriptor, disabled: false, sampleRate: 48000, onChange };
  const ui = render(<EffectParameters {...props} node={node} />);
  fireEvent.keyDown(ui.getByRole("slider", { name: "EQ band 2" }), { key: "ArrowUp" });
  expect(onChange.mock.lastCall?.[0]).toMatchObject({
    band2GainDB: 0.5,
    band1GainDB: 0,
    band3GainDB: 0,
  });
  node = { ...node, params: onChange.mock.lastCall?.[0] };
  ui.rerender(<EffectParameters {...props} node={node} />);
  fireEvent.wheel(ui.getByRole("slider", { name: "EQ band 2" }), { deltaY: -120 });
  expect(onChange.mock.lastCall?.[0].band2Q).toBeGreaterThan(1);
  expect(onChange.mock.lastCall?.[0].band1Q).toBe(1);
  fireEvent.contextMenu(ui.getByRole("slider", { name: "EQ band 2" }));
  fireEvent.click(await ui.findByRole("menuitemradio", { name: "lowshelf" }));
  expect(onChange.mock.lastCall?.[0].band2Type).toBe("lowshelf");
  fireEvent.change(ui.getByRole("spinbutton", { name: "Band 3 Threshold (dB)" }), {
    target: { value: "-70" },
  });
  node = { ...node, params: onChange.mock.lastCall?.[0] };
  ui.rerender(<EffectParameters {...props} node={node} />);
  fireEvent.change(ui.getByRole("combobox", { name: "Bands" }), { target: { value: "1" } });
  node = { ...node, params: onChange.mock.lastCall?.[0] };
  ui.rerender(<EffectParameters {...props} node={node} />);
  expect(ui.queryByRole("spinbutton", { name: "Band 3 Threshold (dB)" })).toBeNull();
  expect(node.params.band3ThresholdDB).toBe(-70);
  fireEvent.change(ui.getByRole("combobox", { name: "Bands" }), { target: { value: "3" } });
  node = { ...node, params: onChange.mock.lastCall?.[0] };
  ui.rerender(<EffectParameters {...props} node={node} />);
  expect(ui.getByRole("spinbutton", { name: "Band 3 Threshold (dB)" })).toHaveProperty(
    "value",
    "-70",
  );
  expect(ui.getByRole("spinbutton", { name: "Band 2 Gain (dB)" })).toHaveProperty("value", "0.5");
});
