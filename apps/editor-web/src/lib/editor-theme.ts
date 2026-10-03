/** CSS owns the defaults; both canvas painters and DOM controls use these roles. */
export const EDITOR_THEME_PROPERTIES = {
  background: "--editor-background",
  foreground: "--editor-foreground",
  mutedForeground: "--editor-muted-foreground",
  border: "--editor-border",
  primary: "--editor-primary",
  focus: "--editor-focus",
  selection: "--editor-selection",
  selectionFill: "--editor-selection-fill",
  waveformBackground: "--editor-waveform-background",
  waveformPeak: "--editor-waveform-peak",
  waveformSample: "--editor-waveform-sample",
  waveformRms: "--editor-waveform-rms",
  playhead: "--editor-playhead",
  warning: "--editor-warning",
  destructive: "--editor-destructive",
  error: "--editor-error",
} as const;

export type EditorPalette = Readonly<Record<keyof typeof EDITOR_THEME_PROPERTIES, string>>;

/**
 * Resolve after the stylesheet loads, then reuse the snapshot while painting.
 * Pass the canvas/container to respect scoped overrides. Re-resolve on a theme
 * change; there is no global cache that could retain another document's theme.
 * Missing styles are an explicit error, not an invalid canvas `var()` color.
 */
export function resolveEditorPalette(element: Element = document.documentElement): EditorPalette {
  const root = element.ownerDocument.documentElement;
  const view = element.ownerDocument.defaultView;
  if (!view) throw new Error("Editor theme needs a document with computed styles");
  const styles = view.getComputedStyle(element);
  const rootStyles = element === root ? styles : view.getComputedStyle(root);
  const palette = {} as Record<keyof typeof EDITOR_THEME_PROPERTIES, string>;
  for (const key of Object.keys(EDITOR_THEME_PROPERTIES) as (keyof EditorPalette)[]) {
    const property = EDITOR_THEME_PROPERTIES[key];
    const value =
      styles.getPropertyValue(property).trim() || rootStyles.getPropertyValue(property).trim();
    if (!value || /\bvar\s*\(/i.test(value)) {
      throw new Error(`Editor theme property ${property} is missing or unresolved`);
    }
    palette[key] = value;
  }
  return Object.freeze(palette);
}
