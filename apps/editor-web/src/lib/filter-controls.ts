import type { EffectDescriptor, EffectParameterDescriptor } from "@aae/protocol";
import type { RackEffect } from "@/lib/effect-presets";

/** UI availability follows the tagged kernel designer; this does not design or process filters. */
export function filterFamilySupports(kind: string, family: string): boolean {
  if (family === "rbj") return true;
  if (family === "moog") return kind === "lowpass";
  if (family === "bessel") return kind === "lowpass" || kind === "highpass";
  return ["lowpass", "highpass", "peak", "lowshelf", "highshelf"].includes(kind);
}

export function filterOrderOptions(kind: string, family: string, maximum = 20): number[] {
  if (family === "moog") return [2, 4, 8, 12];
  if (family === "rbj") return [];
  const max = Math.min(maximum, family === "bessel" ? 10 : family === "elliptic" ? 12 : 20);
  return kind === "peak"
    ? Array.from({ length: (max - 2) / 2 }, (_, index) => 4 + index * 2)
    : Array.from({ length: max }, (_, index) => index + 1);
}

export function filterParameters(
  descriptor: EffectDescriptor,
  node: RackEffect,
): EffectParameterDescriptor[] {
  const kind = String(node.params.kind ?? "lowpass");
  const family = String(node.params.family ?? "rbj");
  const peak = kind === "peak" && family !== "rbj";
  const shaped = ["lowpass", "highpass", "lowshelf", "highshelf"].includes(kind);
  return descriptor.parameters
    .filter((parameter) => {
      switch (parameter.id) {
        case "q":
          return family === "rbj" || family === "moog";
        case "order":
          return family !== "rbj";
        case "rippleDB":
          return shaped && (family === "chebyshev1" || family === "elliptic");
        case "stopbandDB":
          return (
            shaped &&
            (family === "chebyshev2" ||
              (family === "elliptic" && ["lowpass", "highpass"].includes(kind)))
          );
        case "bandwidthHz":
          return peak;
        default:
          return true;
      }
    })
    .map((parameter) => {
      if (parameter.id === "family")
        return {
          ...parameter,
          options: parameter.options
            ?.filter((option) => filterFamilySupports(kind, option.value))
            .map((option) => ({
              ...option,
              label:
                (
                  {
                    rbj: "RBJ / biquad",
                    chebyshev1: "Chebyshev I",
                    chebyshev2: "Chebyshev II",
                    moog: "Moog ladder",
                  } as Record<string, string>
                )[option.value] ?? option.label,
            })),
        };
      if (parameter.id === "kind") return { ...parameter, label: "Type" };
      if (parameter.id === "rippleDB") return { ...parameter, label: "Ripple" };
      if (parameter.id === "stopbandDB")
        return {
          ...parameter,
          label: ["lowshelf", "highshelf"].includes(kind) ? "Ripple bound" : "Stopband",
        };
      if (parameter.id === "bandwidthHz") return { ...parameter, label: "Bandwidth" };
      if (parameter.id === "freq")
        return {
          ...parameter,
          label: ["lowpass", "highpass"].includes(kind) ? "Cutoff" : "Frequency",
        };
      if (parameter.id === "q" && family === "moog")
        return { ...parameter, label: "Resonance", min: 0, max: 4 };
      if (parameter.id === "gain")
        return {
          ...parameter,
          label:
            family === "moog"
              ? "Drive"
              : ["peak", "lowshelf", "highshelf"].includes(kind)
                ? "Gain"
                : "Output gain",
        };
      return parameter;
    });
}
