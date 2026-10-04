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
