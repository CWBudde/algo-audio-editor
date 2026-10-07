/** Match the effect-chain web demo's category names and ordering. */
export const EFFECT_MENU_CATEGORIES = [
  "Filters",
  "Dynamics",
  "Modulation",
  "Time/Space",
  "Pitch",
  "Spatial",
  "Color",
  "Routing",
  "Other",
] as const;

export function isStandardFilter(id: string): boolean {
  return (
    id === "filter" ||
    /^filter-(lowpass|highpass|bandpass|notch|allpass|peak|lowshelf|highshelf|moog)$/.test(id)
  );
}

export function isWeightingFilter(id: string): boolean {
  return id === "filter-a-weighting" || id === "filter-c-weighting";
}

/** Consolidate UI entry points while retaining the original DSP catalogue and saved node types. */
export function effectMenuEntries<T extends { id: string; name: string }>(
  effects: readonly T[],
): T[] {
  const standard = effects.find((effect) => effect.id === "filter");
  const weighting = effects.find((effect) => effect.id === "filter-a-weighting");
  return effects
    .filter(
      (effect) =>
        (!standard || !isStandardFilter(effect.id) || effect.id === standard.id) &&
        (!weighting || !isWeightingFilter(effect.id) || effect.id === weighting.id),
    )
    .map((effect) =>
      isWeightingFilter(effect.id) ? { ...effect, name: "Weighting filters" } : effect,
    );
}

export function effectMenuCategory(effect: { id: string; category?: string }): string {
  // The upstream catalogue uses broader categories for these demo entries.
  if (effect.id === "delay-simple") return "Routing";
  if (effect.id === "bass") return "Spatial";
  if (effect.id === "vocoder") return "Color";
  switch (effect.category) {
    case "EQ":
      return "Filters";
    case "Time":
      return "Time/Space";
    case "Pitch and spectral":
      return "Pitch";
    case "Distortion":
      return "Color";
    default:
      return EFFECT_MENU_CATEGORIES.find((category) => category === effect.category) ?? "Other";
  }
}
