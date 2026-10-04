import { expect, it } from "vitest";
import { nativeMenu } from "./native-menu";

it("keeps command identities, enabled state, separators, shortcuts and effect groups", () => {
  const menu = nativeMenu([
    { id: "file.open", menu: "File", label: "Open…", enabled: true, ariaShortcut: "Meta+O" },
    { id: "file.save", menu: "File", label: "Save…", enabled: false, ariaShortcut: "Control+S" },
    { id: "effects.rack", menu: "Effects", label: "Effects rack…", enabled: true },
    {
      id: "effects.distortion",
      menu: "Effects",
      submenu: "Color",
      label: "Distortion…",
      enabled: false,
    },
  ]);
  expect(menu.find((item) => item.label === "File")?.children).toEqual([
    { id: "file.open", label: "Open…", enabled: true, accelerator: "Command+O" },
    { separator: true },
    { id: "file.save", label: "Save…", enabled: false, accelerator: "Control+S" },
  ]);
  expect(menu.find((item) => item.label === "Effects")?.children).toContainEqual({
    label: "Color",
    children: [{ id: "effects.distortion", label: "Distortion…", enabled: false }],
  });
});
