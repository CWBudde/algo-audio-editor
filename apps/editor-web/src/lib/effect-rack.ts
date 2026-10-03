import type { EffectDescriptor, EffectGraph } from "@aae/protocol";
import type { RackEffect } from "./effect-presets";
export function createRackEffect(descriptor: EffectDescriptor): RackEffect {
  return {
    id: crypto.randomUUID(),
    type: descriptor.id,
    params: Object.fromEntries(
      descriptor.parameters.map((parameter) => [
        parameter.id,
        parameter.type === "enum"
          ? (parameter.defaultString ?? parameter.options?.[0]?.value ?? "")
          : parameter.default,
      ]),
    ),
  };
}
export function rackGraph(rack: readonly RackEffect[]): EffectGraph {
  const nodes = [
    { id: "_input", type: "_input", params: {} },
    ...rack.map(({ id, type, params, bypassed }) => ({
      id,
      type,
      params: { ...params },
      bypassed,
    })),
    { id: "_output", type: "_output", params: {} },
  ];
  return {
    nodes,
    connections: nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id })),
  };
}
export function stereoSelection(channelMask: number): boolean {
  return channelMask > 0 && (channelMask & 0x55) << 1 === (channelMask & 0xaa);
}
export function validRack(
  rack: readonly RackEffect[],
  descriptors: readonly EffectDescriptor[],
  channelMask?: number,
): boolean {
  if (!rack.length || rack.length > 32 || new Set(rack.map((node) => node.id)).size !== rack.length)
    return false;
  return rack.every((node) => {
    const descriptor = descriptors.find((effect) => effect.id === node.type);
    if (
      !descriptor ||
      (descriptor.channelMode === "stereo" &&
        channelMask !== undefined &&
        !stereoSelection(channelMask))
    )
      return false;
    if (
      node.type === "reverb-conv" &&
      (!node.irAssetId || !Number.isInteger(node.params.irIndex) || Number(node.params.irIndex) < 0)
    )
      return false;
    return descriptor.parameters.every((parameter) => {
      const value = node.params[parameter.id];
      if (parameter.type === "enum")
        return (
          typeof value === "string" &&
          Boolean(parameter.options?.some((option) => option.value === value))
        );
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= parameter.min &&
        value <= parameter.max &&
        (parameter.type !== "boolean" || value === 0 || value === 1)
      );
    });
  });
}
