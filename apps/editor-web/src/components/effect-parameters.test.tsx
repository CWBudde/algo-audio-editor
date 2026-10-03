import type { EffectDescriptor } from "@aae/protocol";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { KernelClient } from "@/kernel/client";
import { EffectParameters } from "./effect-parameters";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("keeps nonlinear Moog controls usable without requesting a linear response and restores supported curves", async () => {
  vi.useFakeTimers();
  const descriptor: EffectDescriptor = {
    id: "filter-lowpass",
    name: "Lowpass",
    category: "Filters",
    channelMode: "mono",
    view: "eq",
    presets: [],
    parameters: [
      {
        id: "family",
        label: "Family",
        unit: "",
        type: "enum",
        min: 0,
        max: 0,
        default: 0,
        defaultString: "rbj",
        scale: "lin",
        step: 0,
        options: [
          { value: "rbj", label: "RBJ" },
          { value: "moog", label: "Moog" },
        ],
      },
    ],
  };
  const data = new Float64Array([20, 0, 20000, -12]).buffer;
  const call = vi.fn().mockResolvedValue({ axis: "frequency", count: 2, dataBytes: 32, data });
  const client = { call } as unknown as KernelClient;
  const properties = { descriptor, client, disabled: false, sampleRate: 48000, onChange: vi.fn() };
  const ui = render(
    <EffectParameters
      {...properties}
      node={{ id: "fx", type: "filter-lowpass", params: { family: "moog" } }}
    />,
  );
  expect(ui.getByLabelText("Family")).toHaveProperty("disabled", false);
  expect(ui.getByText(/Moog response depends on the input signal/)).toBeTruthy();
  expect(ui.queryByRole("img")).toBeNull();
  await act(async () => vi.advanceTimersByTime(50));
  expect(call).not.toHaveBeenCalled();
  ui.rerender(
    <EffectParameters
      {...properties}
      node={{ id: "fx", type: "filter-lowpass", params: { family: "rbj" } }}
    />,
  );
  await act(async () => vi.advanceTimersByTime(50));
  expect(call).toHaveBeenCalledExactlyOnceWith("effects.response", {
    effectId: "filter-lowpass",
    params: { family: "rbj" },
    sampleRate: 48000,
    points: 256,
    mode: "frequency",
  });
  expect(ui.getByTestId("effect-response-path").getAttribute("d")).toMatch(/^M\S+/);
  expect(ui.queryByRole("alert")).toBeNull();
  ui.rerender(
    <EffectParameters
      {...properties}
      node={{ id: "fx", type: "filter-lowpass", params: { family: "moog" } }}
    />,
  );
  await act(async () => vi.advanceTimersByTime(50));
  expect(call).toHaveBeenCalledOnce();
  expect(ui.queryByRole("img")).toBeNull();
});
