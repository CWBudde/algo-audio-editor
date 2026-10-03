import type { EffectDescriptor } from "@aae/protocol";
import { expect, it } from "vitest";
import { createRackEffect, rackGraph, stereoSelection, validRack } from "./effect-rack";

const stereo: EffectDescriptor = {
  id: "spatial-pan",
  name: "Panner",
  category: "Spatial",
  channelMode: "stereo",
  view: "generic",
  parameters: [
    {
      id: "pan",
      label: "Pan",
      unit: "",
      type: "number",
      min: -1,
      max: 1,
      default: 0,
      scale: "lin",
      step: 0.01,
    },
  ],
  presets: [],
};
it.each([
  [1, false],
  [2, false],
  [3, true],
  [6, false],
  [12, true],
  [15, true],
  [51, true],
  [255, true],
  [0, false],
])("requires complete adjacent stereo pairs for mask %i", (mask, supported) =>
  expect(stereoSelection(Number(mask))).toBe(supported),
);
it("validates descriptor bounds and channel mode independently of graph order", () => {
  const node = createRackEffect(stereo);
  expect(validRack([node], [stereo], 3)).toBe(true);
  expect(validRack([node], [stereo], 1)).toBe(false);
  expect(validRack([{ ...node, params: { pan: 2 } }], [stereo], 3)).toBe(false);
  expect(rackGraph([node]).connections).toEqual([
    { from: "_input", to: node.id },
    { from: node.id, to: "_output" },
  ]);
});
