import type { EffectDescriptor } from "@aae/protocol";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { KernelClient } from "@/kernel/client";
import { createRackEffect } from "@/lib/effect-rack";
import { EffectParameters } from "./effect-parameters";

const descriptor: EffectDescriptor = {
  id: "dyn-multiband",
  name: "Multiband compressor",
  category: "Dynamics",
  view: "generic",
  channelMode: "mono",
  presets: [],
  parameters: [
    ...Object.entries({
      bands: 3,
      order: 4,
      cross1Hz: 250,
      cross2Hz: 3000,
      cross3Hz: 8000,
      attackMs: 8,
      releaseMs: 120,
      kneeDB: 6,
      makeupGainDB: 0,
      autoMakeup: 0,
      perBand: 0,
      responseBand: 0,
    }).map(([id, value]) => ({
      id,
      label: id,
      type: "number" as const,
      unit: id.endsWith("Hz") ? "Hz" : "",
      min: 0,
      max: id === "bands" ? 4 : id === "order" ? 24 : 20000,
      default: value,
      step: 1,
      scale: "lin" as const,
    })),
    ...["low", "mid", "upper", "high"].flatMap((prefix) =>
      Object.entries({
        AttackMs: 8,
        ReleaseMs: 120,
        ThresholdDB: -20,
        Ratio: 4,
        KneeDB: 6,
        MakeupGainDB: 0,
        AutoMakeup: 0,
      }).map(([suffix, value]) => ({
        id: prefix + suffix,
        label: prefix + suffix,
        type: "number" as const,
        unit: suffix.endsWith("Ms") ? "ms" : suffix.endsWith("DB") ? "dB" : "",
        min: suffix === "ThresholdDB" ? -80 : 0,
        max: 1000,
        default: value,
        step: 0.1,
        scale: "lin" as const,
      })),
    ),
    {
      id: "topology",
      label: "Topology",
      type: "enum",
      unit: "",
      min: 0,
      max: 0,
      default: 0,
      step: 0,
      scale: "lin",
      defaultString: "feedforward",
      options: [
        { value: "feedforward", label: "Feedforward" },
        { value: "feedback", label: "Feedback" },
      ],
    },
  ],
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("materializes inherited settings before the first band edit and retains independent manual makeup", () => {
  let node = createRackEffect(descriptor);
  node.params = { ...node.params, attackMs: 15, releaseMs: 150, kneeDB: 10, makeupGainDB: 3 };
  const onChange = vi.fn();
  const props = { descriptor, disabled: false, sampleRate: 48000, onChange };
  const ui = render(<EffectParameters {...props} node={node} />);
  expect(ui.getByRole("spinbutton", { name: "Low Attack (ms)" })).toHaveProperty("value", "15");
  fireEvent.change(ui.getByRole("spinbutton", { name: "Low Attack (ms)" }), {
    target: { value: "2" },
  });
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({
      perBand: 1,
      lowAttackMs: 2,
      midAttackMs: 15,
      upperAttackMs: 15,
      highAttackMs: 15,
      midReleaseMs: 150,
      highKneeDB: 10,
      lowMakeupGainDB: 3,
      highAutoMakeup: 0,
    }),
  );
  node = { ...node, params: onChange.mock.lastCall?.[0] };
  ui.rerender(<EffectParameters {...props} node={node} />);
  fireEvent.click(ui.getByRole("checkbox", { name: "Low auto gain" }));
  node = { ...node, params: onChange.mock.lastCall?.[0] };
  ui.rerender(<EffectParameters {...props} node={node} />);
  expect(ui.getByRole("spinbutton", { name: "Low Makeup (dB)" })).toHaveProperty("disabled", true);
  expect(ui.getByRole("spinbutton", { name: "Low Makeup (dB)" })).toHaveProperty("value", "3");
  expect(ui.getByRole("spinbutton", { name: "Mid Makeup (dB)" })).toHaveProperty("disabled", false);
  fireEvent.click(ui.getByRole("checkbox", { name: "Low auto gain" }));
  node = { ...node, params: onChange.mock.lastCall?.[0] };
  ui.rerender(<EffectParameters {...props} node={node} />);
  expect(ui.getByRole("spinbutton", { name: "Low Makeup (dB)" })).toHaveProperty("disabled", false);
  expect(node.params.lowMakeupGainDB).toBe(3);
  expect(node.params.lowAttackMs).toBe(2);
});

it("retains hidden bands and requests each actual multiband gain computer from the kernel", async () => {
  vi.useFakeTimers();
  let node = createRackEffect(descriptor);
  node.params = { ...node.params, bands: 4, upperThresholdDB: -42 };
  const onChange = vi.fn();
  const call = vi
    .fn()
    .mockResolvedValue({ count: 2, data: new Float64Array([-80, -80, 0, -12]).buffer });
  const props = {
    descriptor,
    disabled: false,
    sampleRate: 48000,
    onChange,
    client: { call } as unknown as KernelClient,
  };
  const ui = render(<EffectParameters {...props} node={node} />);
  await act(async () => vi.advanceTimersByTime(50));
  expect(call).toHaveBeenCalledTimes(4);
  for (let responseBand = 0; responseBand < 4; responseBand++)
    expect(call).toHaveBeenCalledWith("effects.response", {
      effectId: "dyn-multiband",
      mode: "transfer",
      sampleRate: 48000,
      points: 256,
      params: { ...node.params, responseBand },
    });
  expect(ui.getAllByRole("img")).toHaveLength(4);
  expect(ui.queryByText("Input (dB)")).toBeNull();
  fireEvent.change(ui.getByRole("combobox", { name: "Bands" }), { target: { value: "2" } });
  node = { ...node, params: onChange.mock.lastCall?.[0] };
  ui.rerender(<EffectParameters {...props} node={node} />);
  expect(ui.getAllByRole("img")).toHaveLength(2);
  expect(ui.getByRole("spinbutton", { name: "High Threshold (dB)" })).toBeTruthy();
  expect(node.params.upperThresholdDB).toBe(-42);
  fireEvent.change(ui.getByRole("combobox", { name: "Bands" }), { target: { value: "4" } });
  node = { ...node, params: onChange.mock.lastCall?.[0] };
  ui.rerender(<EffectParameters {...props} node={node} />);
  expect(ui.getByRole("spinbutton", { name: "High mid Threshold (dB)" })).toHaveProperty(
    "value",
    "-42",
  );
});
