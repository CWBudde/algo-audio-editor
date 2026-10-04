interface KeyInput {
  key: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}
const keyName = (key: string) => (key === " " ? "space" : key.replace(/^Arrow/, "").toLowerCase());

/** Keep editor accelerators in the renderer on macOS, where registration cannot be disabled. */
export function matchesAccelerator(accelerator: string, input: KeyInput) {
  const parts = accelerator.split("+");
  const key = parts.pop() ?? "";
  const modifiers = new Set(parts.map((part) => part.toLowerCase()));
  return (
    keyName(key) === keyName(input.key) &&
    input.meta === modifiers.has("command") &&
    input.control === modifiers.has("control") &&
    input.alt === modifiers.has("alt") &&
    input.shift === modifiers.has("shift")
  );
}
