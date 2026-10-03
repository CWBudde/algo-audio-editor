import { cleanup, fireEvent, render } from "@testing-library/react";
import { Copy } from "lucide-react";
import { afterEach, expect, it, vi } from "vitest";
import { IconAction } from "./icon-action";

afterEach(cleanup);

it("keeps an accessible name and shortcut tooltip without a visible text label", () => {
  const onClick = vi.fn();
  const ui = render(
    <IconAction
      icon={Copy}
      label="Copy"
      shortcutLabel="Ctrl+C"
      ariaShortcut="Control+C"
      onClick={onClick}
      testId="copy-action"
    />,
  );
  const button = ui.getByRole("button", { name: "Copy" });
  expect(button.title).toBe("Copy (Ctrl+C)");
  expect(button.getAttribute("aria-keyshortcuts")).toBe("Control+C");
  expect(button.textContent).toBe("");
  expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  expect(ui.getByTestId("copy-action")).toBe(button);
  button.focus();
  expect(document.activeElement).toBe(button);
  fireEvent.click(button);
  expect(onClick).toHaveBeenCalledOnce();
});

it("disables activation and supports actions with no keyboard shortcut", () => {
  const onClick = vi.fn();
  const ui = render(
    <IconAction icon={Copy} label="Copy" disabled onClick={onClick} variant="destructive" />,
  );
  const button = ui.getByRole("button", { name: "Copy" });
  expect(button.title).toBe("Copy");
  expect(button.hasAttribute("aria-keyshortcuts")).toBe(false);
  fireEvent.click(button);
  expect(onClick).not.toHaveBeenCalled();
});
