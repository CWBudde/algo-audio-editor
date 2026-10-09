import { expect, it } from "vitest";
import { nativeMenu } from "./native-menu";

it("keeps command identities, enabled state, separators, shortcuts and effect groups", () => {
  const menu = nativeMenu([
    { id: "file.open", menu: "File", label: "Open…", enabled: true, ariaShortcut: "Meta+O" },
    { id: "file.save", menu: "File", label: "Save…", enabled: false, ariaShortcut: "Control+S" },
    { id: "file.metadata", menu: "File", label: "File metadata…", enabled: true },
    { id: "file.automation", menu: "File", label: "Macros and automation…", enabled: true },
    { id: "file.record-macro", menu: "File", label: "Record new macro", enabled: true },
    { id: "file.stop-recording", menu: "File", label: "Stop recording macro", enabled: false },
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
    { separator: true },
    { id: "file.metadata", label: "File metadata…", enabled: true },
    { separator: true },
    { id: "file.automation", label: "Macros and automation…", enabled: true },
    { id: "file.record-macro", label: "Record new macro", enabled: true },
    { id: "file.stop-recording", label: "Stop recording macro", enabled: false },
  ]);
  expect(menu.find((item) => item.label === "Effects")?.children).toContainEqual({
    label: "Color",
    children: [{ id: "effects.distortion", label: "Distortion…", enabled: false }],
  });
});

it("mirrors the Help menu's shortcut list and diagnostics commands", () => {
  const menu = nativeMenu([
    { id: "commands.palette", menu: "Help", label: "Command palette…", enabled: true },
    { id: "help.shortcuts", menu: "Help", label: "Keyboard shortcuts…", enabled: true },
    { id: "help.diagnostics", menu: "Help", label: "Copy diagnostics", enabled: false },
    { id: "help.about", menu: "Help", label: "About", enabled: true },
  ]);
  expect(menu.find((item) => item.label === "Help")?.children).toEqual([
    { id: "commands.palette", label: "Command palette…", enabled: true },
    { id: "help.shortcuts", label: "Keyboard shortcuts…", enabled: true },
    { separator: true },
    { id: "help.diagnostics", label: "Copy diagnostics", enabled: false },
    { id: "help.about", label: "About", enabled: true },
  ]);
});
